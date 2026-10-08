import qrcode from "qrcode-generator";

export function parseNode(uri, label) {
  const u = new URL(uri.trim()),
    q = u.searchParams;
  if (
    u.protocol !== "vless:" ||
    u.password ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      u.username,
    ) ||
    q.get("security") !== "tls" ||
    q.get("type") !== "ws" ||
    !q.get("path")?.startsWith("/__pingu_device__/v1/")
  )
    throw new Error("unsupported_node");
  if (
    q.get("flow") ||
    q.get("pbk") ||
    !u.hostname ||
    Number(u.port || 443) < 1 ||
    Number(u.port || 443) > 65535
  )
    throw new Error("unsupported_node");
  return {
    name: label,
    type: "vless",
    server: u.hostname,
    port: Number(u.port || 443),
    uuid: u.username,
    udp: true,
    tls: true,
    servername: q.get("sni") || q.get("host") || u.hostname,
    "client-fingerprint": q.get("fp") || "chrome",
    network: "ws",
    "ws-opts": {
      path: q.get("path"),
      headers: { Host: q.get("host") || u.hostname },
    },
  };
}
export function renderSubscription(entries, format) {
  const proxies = entries.map(({ uri, label }) => parseNode(uri, label));
  if (format === "clash")
    // Hiddify treats JSON as sing-box before trying Clash. Its iOS profile
    // loader also trims each line, so keep nested YAML values in flow style.
    return Object.entries({
      "mixed-port": 7890,
      "allow-lan": false,
      ipv6: false,
      mode: "rule",
      "log-level": "info",
      proxies,
      "proxy-groups": [
        {
          name: "PROXY",
          type: "select",
          proxies: proxies.map((x) => x.name),
        },
      ],
      rules: ["MATCH,PROXY"],
    })
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
      .join("");
  if (format === "sing-box")
    return (
      JSON.stringify(
        {
          outbounds: proxies.map((p) => ({
            type: "vless",
            tag: p.name,
            server: p.server,
            server_port: p.port,
            uuid: p.uuid,
            packet_encoding: "xudp",
            tls: {
              enabled: true,
              server_name: p.servername,
              utls: { enabled: true, fingerprint: p["client-fingerprint"] },
            },
            transport: {
              type: "ws",
              path: p["ws-opts"].path,
              headers: p["ws-opts"].headers,
            },
          })),
        },
        null,
        2,
      ) + "\n"
    );
  return (
    entries
      .map(({ uri, label }) => {
        const u = new URL(uri.trim());
        u.hash = encodeURIComponent(label);
        return u.href;
      })
      .join("\n") + "\n"
  );
}

export function renderSubscriptionQR(url) {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
}
