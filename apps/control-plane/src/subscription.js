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
    return (
      JSON.stringify(
        {
          "mixed-port": 7890,
          "allow-lan": false,
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
