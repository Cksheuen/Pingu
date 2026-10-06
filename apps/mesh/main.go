// Pingu's userspace mesh sidecar. It creates no host TUN, changes no DNS or
// system routes, and exposes no host service unless the inbound gate permits it.
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/socks5"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

type launchConfig struct {
	StateDir     string   `json:"state_dir"`
	Hostname     string   `json:"hostname"`
	ControlURL   string   `json:"control_url"`
	AuthKey      string   `json:"auth_key,omitempty"`
	APIToken     string   `json:"api_token"`
	AllowInbound bool     `json:"allow_inbound"`
	ExposedPorts []uint16 `json:"exposed_ports"`
	BlockedPorts []uint16 `json:"blocked_ports"`
}

type peer struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
	Online    bool     `json:"online"`
	OS        string   `json:"os"`
	Path      string   `json:"path"`
}

type meshStatus struct {
	State              string   `json:"state"`
	Name               string   `json:"name"`
	Addresses          []string `json:"addresses"`
	Peers              []peer   `json:"peers"`
	AuthURL            string   `json:"auth_url,omitempty"`
	AllowInbound       bool     `json:"allow_inbound"`
	ExposedPorts       []uint16 `json:"exposed_ports"`
	InboundConnections int      `json:"inbound_connections"`
	SocksPort          uint16   `json:"socks_port"`
}

type meshApp struct {
	server    *tsnet.Server
	client    *local.Client
	gate      *inboundGate
	token     string
	socksPort uint16
}

func main() {
	file := flag.String("config", "", "private launch configuration (otherwise read one JSON line from stdin)")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var cfg launchConfig
	var err error
	if *file != "" {
		var data []byte
		data, err = os.ReadFile(*file)
		if err == nil {
			err = decodeConfig(strings.NewReader(string(data)), &cfg)
		}
	} else {
		reader := bufio.NewReader(io.LimitReader(os.Stdin, 64*1024))
		var line []byte
		line, err = reader.ReadBytes('\n')
		if err == nil {
			err = decodeConfig(strings.NewReader(string(line)), &cfg)
			// A crashed/terminated parent closes the pipe, which tears down
			// the overlay and all bridges instead of leaving an orphan daemon.
			go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Invalid mesh launch configuration")
		os.Exit(2)
	}
	if err := run(ctx, cfg); err != nil {
		// Network libraries may include auth URLs or secrets in error strings.
		// Detailed service state is available only through the private API.
		fmt.Fprintln(os.Stderr, "Pingu mesh stopped before it became available")
		os.Exit(1)
	}
}

func decodeConfig(reader io.Reader, cfg *launchConfig) error {
	decoder := json.NewDecoder(io.LimitReader(reader, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(cfg); err != nil {
		return err
	}
	u, err := url.Parse(cfg.ControlURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("coordination server must be an HTTPS origin")
	}
	if !filepath.IsAbs(cfg.StateDir) || len(cfg.APIToken) < 32 || len(cfg.Hostname) == 0 || len(cfg.Hostname) > 63 {
		return errors.New("invalid private state directory, token, or hostname")
	}
	for _, c := range cfg.Hostname {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return errors.New("hostname must be a DNS label")
		}
	}
	return nil
}

func run(ctx context.Context, cfg launchConfig) error {
	if err := os.MkdirAll(cfg.StateDir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(cfg.StateDir, 0700); err != nil {
		return err
	}
	apiListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer apiListener.Close()
	socksListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer socksListener.Close()
	apiPort := uint16(apiListener.Addr().(*net.TCPAddr).Port)
	socksPort := uint16(socksListener.Addr().(*net.TCPAddr).Port)
	gate := newInboundGate(append(cfg.BlockedPorts, apiPort, socksPort)...)
	if err := gate.configure(cfg.AllowInbound, cfg.ExposedPorts); err != nil {
		return err
	}
	defer gate.configure(false, nil)
	quiet := func(string, ...any) {}
	srv := &tsnet.Server{
		Dir: cfg.StateDir, Hostname: cfg.Hostname, ControlURL: cfg.ControlURL,
		AuthKey: cfg.AuthKey, Logf: quiet, UserLogf: quiet,
	}
	srv.RegisterFallbackTCPHandler(gate.handler)
	if err := srv.Start(); err != nil {
		return err
	}
	defer srv.Close()
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}
	app := &meshApp{server: srv, client: lc, gate: gate, token: cfg.APIToken, socksPort: socksPort}
	socks := &socks5.Server{Dialer: app.dialPeer, Logf: quiet}
	httpServer := &http.Server{
		Handler: app, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 4096,
	}
	done := make(chan error, 2)
	go func() { done <- socks.Serve(socksListener) }()
	go func() { done <- httpServer.Serve(apiListener) }()
	defer httpServer.Close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"protocol": 1, "api_port": apiPort, "socks_port": socksPort,
	}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return nil
	case err := <-done:
		return err
	}
}

func (a *meshApp) state(ctx context.Context) (*ipnstate.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	return a.client.Status(ctx)
}

func (a *meshApp) knownPeer(ctx context.Context, ip netip.Addr) bool {
	state, err := a.state(ctx)
	if err != nil {
		return false
	}
	for _, peer := range state.Peer {
		for _, address := range peer.TailscaleIPs {
			if address.Unmap() == ip.Unmap() {
				return true
			}
		}
	}
	return false
}

func (a *meshApp) dialPeer(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" {
		return nil, errors.New("only TCP services are supported")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid peer destination")
	}
	ip, err := netip.ParseAddr(host)
	p, portErr := strconv.ParseUint(port, 10, 16)
	if err != nil || portErr != nil || p == 0 || !a.knownPeer(ctx, ip) {
		return nil, errors.New("destination is not a member of this mesh")
	}
	return a.server.Dial(ctx, "tcp", net.JoinHostPort(ip.String(), port))
}

func (a *meshApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(provided), []byte(a.token)) != 1 {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	switch {
	case r.Method == "GET" && r.URL.Path == "/status":
		state, err := a.state(r.Context())
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "mesh state unavailable"})
			return
		}
		result := meshStatus{State: state.BackendState, Peers: []peer{}, Addresses: []string{}, SocksPort: a.socksPort}
		result.AllowInbound, result.ExposedPorts, result.InboundConnections = a.gate.snapshot()
		if state.Self != nil {
			result.Name = state.Self.HostName
		}
		for _, address := range state.TailscaleIPs {
			result.Addresses = append(result.Addresses, address.String())
		}
		if u, err := url.Parse(state.AuthURL); err == nil && u.Scheme == "https" {
			result.AuthURL = state.AuthURL
		}
		for _, p := range state.Peer {
			item := peer{ID: string(p.ID), Name: p.HostName, Addresses: []string{}, Online: p.Online, OS: p.OS, Path: "idle"}
			for _, address := range p.TailscaleIPs {
				item.Addresses = append(item.Addresses, address.String())
			}
			// A configured DERP region alone does not prove a relayed path.
			if p.Active {
				switch {
				case p.CurAddr != "":
					item.Path = "direct"
				case p.PeerRelay != "":
					item.Path = "peer-relay"
				case p.Relay != "":
					item.Path = "relay"
				}
			}
			result.Peers = append(result.Peers, item)
		}
		sort.Slice(result.Peers, func(i, j int) bool { return result.Peers[i].Name < result.Peers[j].Name })
		writeJSON(w, 200, result)
	case r.Method == "POST" && r.URL.Path == "/exposure":
		var policy struct {
			Enabled bool     `json:"enabled"`
			Ports   []uint16 `json:"ports"`
		}
		if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid exposure policy"})
			return
		}
		if err := a.gate.configure(policy.Enabled, policy.Ports); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case r.Method == "POST" && r.URL.Path == "/ping":
		var data struct { IP string `json:"ip"` }
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid peer"})
			return
		}
		ip, err := netip.ParseAddr(data.IP)
		if err != nil || !a.knownPeer(r.Context(), ip) {
			writeJSON(w, 400, map[string]string{"error": "unknown mesh peer"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		defer cancel()
		result, err := a.client.Ping(ctx, ip, tailcfg.PingDisco)
		if err != nil || result == nil || result.Err != "" {
			writeJSON(w, 504, map[string]string{"error": "peer did not respond"})
			return
		}
		path := "relay"
		if result.Endpoint != "" { path = "direct" } else if result.PeerRelay != "" { path = "peer-relay" }
		writeJSON(w, 200, map[string]any{"path": path, "latency_ms": result.LatencySeconds * 1000})
	default:
		writeJSON(w, 404, map[string]string{"error": "not found"})
	}
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
