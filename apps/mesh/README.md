# Pingu private networking

This sidecar embeds Tailscale's userspace network stack. Pingu owns its process,
private state and settings; it does not install the Tailscale application or
modify the host's TUN interfaces, DNS, default route or existing VPN sessions.

The coordination URL is an HTTPS Headscale server. A device has its own enrollment
key and durable node identity. Server/relay migration preserves those identities.
Each device's state directory must remain private and must not be cloned to a
second running device.

Pingu sends one private JSON launch record on stdin and retains the pipe. The
sidecar writes a single public readiness record (protocol/API/SOCKS ports), then
exposes a bearer-authenticated loopback API. Parent EOF or termination shuts down
the sidecar. Auth keys and browser registration links are never written to logs.

The SOCKS listener only dials addresses of current mesh peers. It does not forward
arbitrary internet or LAN destinations. The initial version carries TCP services.
Pingu can use this listener for SSH, development web servers and remote desktops.
No relay or exit-node role is advertised by a desktop.

Incoming access is **off by default**. Enabling it shares only selected TCP ports
on `127.0.0.1`. The private app control/proxy ports are reserved. Disabling access
closes existing inbound bridges as well as rejecting new ones, including a local
dial that finishes concurrently with the change. Outbound peer access continues.

Build and test on the authorized Mac mini, not the restricted local workstation:

```sh
go test ./...
go build -trimpath -o pingu-mesh .
```

For server-side probes the same program can be cross-built for Linux and launched
with `-config /private/path/launch.json`. Production app launches use stdin.
Real acceptance must cover both directions, switch-off during an active bridge,
unchanged existing proxy connectivity, and the observed direct/relay path. Unit
tests or a registered node alone do not prove working connectivity.
