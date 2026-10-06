package main

import (
	"context"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"
)

func TestGateDefaultDeniesAndOnlySharesSelectedLoopbackPort(t *testing.T) {
	g := newInboundGate(45000)
	peer := netip.MustParseAddrPort("100.64.0.2:40000")
	destination := netip.MustParseAddrPort("100.64.0.1:8080")
	if handler, handled := g.handler(peer, destination); handler != nil || !handled {
		t.Fatal("default policy did not reject incoming connection")
	}
	if err := g.configure(true, []uint16{45000}); err == nil {
		t.Fatal("private control port was exposed")
	}
	if err := g.configure(true, []uint16{8080}); err != nil {
		t.Fatal(err)
	}
	if g.allowed(22) {
		t.Fatal("an unselected port was exposed")
	}
	called := make(chan string, 1)
	local, service := net.Pipe()
	defer service.Close()
	g.dial = func(_ context.Context, network, address string) (net.Conn, error) {
		called <- network + " " + address
		return local, nil
	}
	accepted, remote := net.Pipe()
	defer remote.Close()
	handler, handled := g.handler(peer, destination)
	if handler == nil || !handled {
		t.Fatal("enabled service rejected")
	}
	finished := make(chan struct{})
	go func() { handler(accepted); close(finished) }()
	if address := <-called; address != "tcp 127.0.0.1:8080" {
		t.Fatalf("unsafe destination: %s", address)
	}
	go func() { _, _ = service.Write([]byte("visible")) }()
	if err := remote.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 7)
	if _, err := io.ReadFull(remote, data); err != nil || string(data) != "visible" {
		t.Fatalf("bridge failed: %v", err)
	}
	if err := g.configure(false, []uint16{8080}); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Read(make([]byte, 1)); err == nil {
		t.Fatal("existing inbound connection survived switch-off")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("bridge leaked after switch-off")
	}
}

func TestDisableWinsAgainstPendingLocalDial(t *testing.T) {
	g := newInboundGate()
	if err := g.configure(true, []uint16{8080}); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	local, service := net.Pipe()
	defer service.Close()
	g.dial = func(_ context.Context, _, _ string) (net.Conn, error) {
		close(started)
		<-release // Simulate a dial returning after policy changed.
		return local, nil
	}
	accepted, remote := net.Pipe()
	defer remote.Close()
	finished := make(chan struct{})
	go func() { g.bridge(accepted, 8080); close(finished) }()
	<-started
	if err := g.configure(false, []uint16{8080}); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("pending dial resurrected disabled access")
	}
	_, _, active := g.snapshot()
	if active != 0 {
		t.Fatal("inbound bridge was retained")
	}
}
