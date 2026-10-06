const $ = (id) => document.getElementById(id);
let state = { nodes: [], devices: [], assignments: [] };
let requestId = null;
const statuses = {
  active: "有效",
  pending: "待同步",
  revoking: "撤销中",
  revoked: "已撤销",
  error: "同步失败",
};
function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "";
}
async function api(path, data) {
  const r = await fetch("/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok) {
    if (r.status === 401) showLogin();
    throw new Error(result.error || "请求失败");
  }
  return result;
}
function showLogin() {
  $("login").hidden = false;
  $("dashboard").hidden = true;
  $("logout").hidden = true;
}
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function button(text, fn, className = "secondary") {
  const b = el("button", text, className);
  b.type = "button";
  b.onclick = () => action(b, fn);
  return b;
}
async function action(b, fn) {
  b.disabled = true;
  try {
    await fn();
  } catch (e) {
    message(e.message, true);
  } finally {
    b.disabled = false;
  }
}
function showLink(value) {
  $("created").hidden = false;
  $("subscription").value = value;
  $("created").scrollIntoView({ behavior: "smooth", block: "center" });
}
function render() {
  $("node-count").textContent = state.nodes.filter((x) => x.enabled).length;
  $("device-count").textContent = state.devices.filter(
    (x) => x.status === "active",
  ).length;
  $("pending-count").textContent = state.devices.filter(
    (x) =>
      ["pending", "revoking"].includes(x.status) ||
      state.assignments.some((a) => a.device_id === x.id && a.error),
  ).length;
  $("nodes").replaceChildren();
  $("devices").replaceChildren();
  if (!state.nodes.length)
    $("nodes").append(el("p", "还没有节点。点击“批量配置 JSON”添加。", "hint"));
  for (const n of state.nodes) {
    const row = el("div", undefined, "row"),
      left = el("div");
    left.append(
      el("div", n.name, "row-title"),
      el("div", `${n.id} · ${n.origin}`, "meta"),
    );
    row.append(
      left,
      el(
        "span",
        n.enabled ? "已启用" : "已隐藏",
        `pill ${n.enabled ? "" : "off"}`,
      ),
    );
    $("nodes").append(row);
  }
  if (!state.devices.length)
    $("devices").append(el("p", "创建第一个设备订阅后会显示在这里。", "hint"));
  for (const d of state.devices) {
    const row = el("div", undefined, "row"),
      left = el("div"),
      title = el("div", `${d.owner} / ${d.name}`, "row-title");
    const info = el("div", undefined, "meta");
    info.append(
      el(
        "span",
        statuses[d.status],
        `pill ${d.status === "active" ? "" : d.status === "revoked" ? "off" : "warn"}`,
      ),
      document.createTextNode(new Date(d.created_at).toLocaleString()),
    );
    const assignments = state.assignments
      .filter((a) => a.device_id === d.id)
      .map(
        (a) =>
          `${state.nodes.find((n) => n.id === a.node_id)?.name || a.node_id}: ${a.error === "revoke_pending" ? "待撤销重试" : a.error ? "需重试同步" : statuses[a.state]}`,
      )
      .join("；");
    left.append(title, info, el("div", assignments, "meta"));
    const actions = el("div", undefined, "actions");
    if (["pending", "active"].includes(d.status)) {
      actions.append(
        button("订阅链接", async () =>
          showLink((await api(`/devices/${d.id}/link`, {})).subscription),
        ),
      );
      actions.append(
        button("同步节点", async () => {
          await api(`/devices/${d.id}/sync`, {});
          await refresh();
          message("已同步，请检查各节点状态。");
        }),
      );
    }
    const meshPending = state.mesh_assignments?.some(a => a.device_id === d.id && a.error);
    left.append(el("div", d.mesh_allowed ? "组网：已允许（本机端口仍由设备自行控制）" : meshPending ? "组网：撤销待重试" : "组网：未允许", "meta"));
    if (d.status === "active") actions.append(button(d.mesh_allowed ? "关闭组网" : meshPending ? "重试关闭组网" : "允许组网", async () => {
      const enabled = !d.mesh_allowed && !meshPending;
      if (enabled && !confirm(`允许 ${d.owner} / ${d.name} 加入你的私有组网？只有设备本地打开的端口可以被其他成员访问。`)) return;
      const result = await api(`/devices/${d.id}/mesh`,{enabled}); await refresh();
      message(result.ok ? (enabled ? "组网已允许，请在这台设备的 Pingu 中连接。" : "组网权限已撤销。") : "组网撤销尚未完成，请重试。",!result.ok);
    }));
    if (d.status !== "revoked")
      actions.append(
        button(
          d.status === "revoking" ? "重试撤销" : "撤销",
          async () => {
            if (
              d.status !== "revoking" &&
              !confirm(
                `撤销 ${d.owner} / ${d.name} 的订阅、组网和新连接权限？此设备无法恢复，可重新创建。`,
              )
            )
              return;
            const r = await api(`/devices/${d.id}/revoke`, {});
            await refresh();
            message(
              r.status === "revoked"
                ? "已撤销所有节点权限。"
                : "订阅已停止，部分节点暂时不可达，恢复后请重试撤销。",
              r.status !== "revoked",
            );
          },
          "danger",
        ),
      );
    row.append(left, actions);
    $("devices").append(row);
  }
}
async function refresh() {
  state = await api("/state");
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("logout").hidden = false;
  render();
}
$("login-form").onsubmit = (e) => {
  e.preventDefault();
  action(e.submitter, async () => {
    await api("/login", { key: $("admin-key").value });
    $("admin-key").value = "";
    message("");
    await refresh();
  });
};
$("logout").onclick = () =>
  action($("logout"), async () => {
    await api("/logout", {});
    state = { nodes: [], devices: [], assignments: [] };
    $("subscription").value = "";
    $("nodes-json").value = "";
    $("created").hidden = true;
    showLogin();
    message("已退出。");
  });
$("refresh").onclick = () => action($("refresh"), refresh);
$("edit-nodes").onclick = () => {
  $("nodes-form").hidden = !$("nodes-form").hidden;
  if (!$("nodes-form").hidden)
    $("nodes-json").value = JSON.stringify(
      state.nodes.length
        ? state.nodes.map((n) => ({
            id: n.id,
            name: n.name,
            origin: n.origin,
            enabled: Boolean(n.enabled),
          }))
        : [
            {
              id: "vps-1",
              name: "节点 1",
              origin: "https://node.example.com",
              enabled: true,
              key: "替换为节点专用控制密钥",
            },
          ],
      null,
      2,
    );
};
$("nodes-form").onsubmit = (e) => {
  e.preventDefault();
  action(e.submitter, async () => {
    const nodes = JSON.parse($("nodes-json").value);
    await api("/nodes", { nodes });
    $("nodes-json").value = "";
    $("nodes-form").hidden = true;
    await refresh();
    message("节点已保存。同步全部设备后，新节点会进入已有订阅。");
  });
};
$("device-form").onsubmit = (e) => {
  e.preventDefault();
  action(e.submitter, async () => {
    requestId ??= crypto.randomUUID().replaceAll("-", "");
    const r = await api("/devices", {
      id: requestId,
      owner: $("owner").value,
      name: $("device-name").value,
    });
    requestId = null;
    await refresh();
    showLink(r.subscription);
    message(
      r.assignments.some((a) => a.error)
        ? "设备已建立，部分节点未同步成功；恢复后点击“同步节点”重试。"
        : "订阅已创建，可复制到客户端。",
      r.assignments.some((a) => a.error),
    );
  });
};
for (const id of ["owner", "device-name"])
  $(id).oninput = () => {
    requestId = null;
  };
$("sync-all").onclick = () =>
  action($("sync-all"), async () => {
    const devices = state.devices.filter((d) =>
      ["active", "pending"].includes(d.status),
    );
    let failed = 0;
    for (const d of devices) {
      try {
        const r = await api(`/devices/${d.id}/sync`, {});
        if (r.assignments.some((a) => a.error)) failed++;
      } catch {
        failed++;
      }
    }
    await refresh();
    message(
      `已处理 ${devices.length} 台设备${failed ? `，其中 ${failed} 台需要重试` : "，全部同步完成"}。`,
      failed > 0,
    );
  });
$("copy-link").onclick = () =>
  action($("copy-link"), async () => {
    await navigator.clipboard.writeText($("subscription").value);
    message("已复制通用订阅链接。");
  });
$("copy-clash").onclick = () =>
  action($("copy-clash"), async () => {
    await navigator.clipboard.writeText(
      $("subscription").value + "?format=clash",
    );
    message("已复制 Clash 订阅链接。");
  });
refresh().catch((e) => {
  if (e.message !== "请先登录") message(e.message, true);
});
