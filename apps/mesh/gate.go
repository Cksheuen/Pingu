package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"sync"
	"time"
)

// The gate is the only bridge from the overlay into host services. It is
// disabled until the owner explicitly enables it. Changing the policy also
// closes existing bridges; a switch-off must not merely block new connections.
type inboundGate struct {
	mu      sync.Mutex
	enabled bool
	ports   map[uint16]bool
	blocked map[uint16]bool
	active  map[*inboundBridge]bool
	dial    func(context.Context, string, string) (net.Conn, error)
}

type inboundBridge struct {
	cancel context.CancelFunc
	peer   net.Conn
	local  net.Conn
}

func newInboundGate(blocked ...uint16) *inboundGate {
	b := make(map[uint16]bool)
	for _, port := range blocked {
		b[port] = true
	}
	return &inboundGate{
		ports: make(map[uint16]bool), blocked: b, active: make(map[*inboundBridge]bool),
		dial: (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	}
}

func (g *inboundGate) configure(enabled bool, ports []uint16) error {
	if len(ports) > 32 {
		return errors.New("at most 32 shared TCP ports are supported")
	}
	allowed := make(map[uint16]bool)
	for _, port := range ports {
		if port == 0 || g.blocked[port] {
			return errors.New("a selected port is reserved for private app control")
		}
		allowed[port] = true
	}
	if enabled && len(allowed) == 0 {
		return errors.New("select at least one TCP port before allowing access")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.enabled, g.ports = enabled, allowed
	// Close on any policy update, including removing a previously shared port.
	for bridge := range g.active {
		bridge.cancel()
		bridge.peer.Close()
		if bridge.local != nil {
			bridge.local.Close()
		}
	}
	return nil
}

func (g *inboundGate) snapshot() (bool, []uint16, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	ports := make([]uint16, 0, len(g.ports))
	for port := range g.ports {
		ports = append(ports, port)
	}
	sort.Slice(ports, func(i, j int) bool { return ports[i] < ports[j] })
	return g.enabled, ports, len(g.active)
}

func (g *inboundGate) allowed(port uint16) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.enabled && g.ports[port] && !g.blocked[port]
}

// A handled nil callback rejects the flow instead of falling through to a
// different handler. The callback re-checks the policy after asynchronous dial.
func (g *inboundGate) handler(_, dst netip.AddrPort) (func(net.Conn), bool) {
	if !g.allowed(dst.Port()) {
		return nil, true
	}
	return func(peer net.Conn) { g.bridge(peer, dst.Port()) }, true
}

func (g *inboundGate) bridge(peer net.Conn, port uint16) {
	ctx, cancel := context.WithCancel(context.Background())
	b := &inboundBridge{cancel: cancel, peer: peer}
	defer cancel()
	defer peer.Close()
	g.mu.Lock()
	if !g.enabled || !g.ports[port] || g.blocked[port] {
		g.mu.Unlock()
		return
	}
	g.active[b] = true
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.active, b)
		g.mu.Unlock()
	}()
	// Overlay destinations can never select another LAN host or an arbitrary
	// address. Sharing is limited to loopback services on this device.
	local, err := g.dial(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))))
	if err != nil {
		return
	}
	defer local.Close()
	g.mu.Lock()
	if ctx.Err() != nil || !g.enabled || !g.ports[port] || g.blocked[port] {
		g.mu.Unlock()
		return
	}
	b.local = local
	g.mu.Unlock()
	finished := make(chan struct{}, 2)
	copyStream := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		finished <- struct{}{}
	}
	go copyStream(local, peer)
	go copyStream(peer, local)
	<-finished
	local.Close()
	peer.Close()
	<-finished
}
