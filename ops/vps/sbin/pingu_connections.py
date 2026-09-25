"""Authenticated VPS connection view; controller credentials never reach HTML."""

import html

CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")


def render(prefix, csrf):
    prefix = html.escape(prefix, quote=True)
    csrf = html.escape(csrf, quote=True)
    return f"""
<style>
.connections-panel{{min-width:0}}.connections-controls{{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:20px 0}}
.connections-controls input{{flex:1;min-width:180px}}.connections-scroll{{overflow:auto;max-height:65vh}}
.connections-table{{width:100%;border-collapse:collapse;font-size:13px;min-width:680px}}
.connections-table th,.connections-table td{{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left}}
.connections-table th{{position:sticky;top:0;background:var(--surface-ice,#f7faff)}}.connections-table small{{display:block;color:var(--muted,#72766d);margin-top:4px}}
.connections-summary{{font-size:15px;margin:12px 0}}.connections-table button{{padding:6px 10px;min-height:32px}}
.connections-status[data-error=true]{{color:#a83728}}.connections-empty{{padding:32px;text-align:center;color:#72766d}}
</style>
<div class="connections-panel" id="connections-app" data-prefix="{prefix}" data-csrf="{csrf}">
<div class="panel-head"><span>连接管理</span><a href="{prefix}">设备管理</a></div>
<h2>VPS 实时连接</h2><p>查看当前目标、来源、路由与流量，按需断开连接。</p>
<div class="connections-summary" id="connection-summary">正在读取连接…</div>
<div class="connections-controls"><input id="connection-search" aria-label="搜索连接" placeholder="搜索域名、来源或路由" type="search">
<button type="button" id="connection-refresh">刷新</button><button type="button" id="connection-close-all">断开全部</button></div>
<p class="connections-status" id="connection-status" role="status" aria-live="polite"></p>
<div class="connections-scroll"><table class="connections-table"><thead><tr><th>目标</th><th>来源</th><th>路由</th><th>流量 ↑ / ↓</th><th>时长</th><th>操作</th></tr></thead><tbody id="connection-rows"></tbody></table></div>
<div id="connection-empty" class="connections-empty" hidden>暂无活动连接</div>
</div><script src="{prefix}/connections.js" defer></script>
"""


SCRIPT = r"""(() => {
  const app = document.getElementById('connections-app');
  const prefix = app.dataset.prefix;
  const status = document.getElementById('connection-status');
  const rows = document.getElementById('connection-rows');
  const search = document.getElementById('connection-search');
  const summary = document.getElementById('connection-summary');
  const empty = document.getElementById('connection-empty');
  let snapshot = null, expired = false, timer = null, generation = 0, running = null, runningGen = -1;
  const bytes = n => {
    let value = Number(n) || 0, unit = 0;
    while (value >= 1024 && unit < 4) { value /= 1024; unit++; }
    return value.toFixed(unit ? 1 : 0) + ' ' + ['B','KiB','MiB','GiB','TiB'][unit];
  };
  const textCell = (row, value, detail) => {
    const cell = document.createElement('td'); cell.textContent = value;
    if (detail) { const small = document.createElement('small'); small.textContent = detail; cell.append(small); }
    row.append(cell); return cell;
  };
  const endpoint = (host, port) => (host || '') + (port === '' || port === undefined || port === null ? '' : ':' + port);
  function render() {
    if (!snapshot) return;
    const connections = snapshot.connections || [];
    const query = search.value.trim().toLowerCase();
    const filtered = connections.filter(c => JSON.stringify([c.metadata, c.rule, c.rulePayload, c.chains]).toLowerCase().includes(query));
    rows.replaceChildren();
    summary.textContent = `${connections.length} 个活动连接 · 累计上传 ${bytes(snapshot.uploadTotal)} · 下载 ${bytes(snapshot.downloadTotal)}`;
    for (const c of filtered) {
      const m = c.metadata || {}, row = document.createElement('tr');
      const device = [m.pinguDeviceOwner, m.pinguDeviceName].filter(Boolean).join(' / ');
      const gateSource = m.pinguBackendSourceIP
        ? 'gate ' + endpoint(m.pinguBackendSourceIP, m.pinguBackendSourcePort) : '';
      textCell(row, endpoint(m.host || m.destinationIP || '未知目标', m.destinationPort), `${m.network || ''} · ${m.type || ''}`);
      textCell(row, endpoint(m.sourceIP || '未知来源', m.sourcePort),
               [device, m.inboundName || m.inboundUser, gateSource].filter(Boolean).join(' · '));
      textCell(row, (c.chains || []).join(' → ') || '—', [c.rule, c.rulePayload].filter(Boolean).join(' · '));
      textCell(row, `${bytes(c.upload)} / ${bytes(c.download)}`);
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(c.start)) / 1000));
      textCell(row, Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : '—');
      const cell = textCell(row, ''), button = document.createElement('button');
      button.type = 'button'; button.textContent = '断开'; button.addEventListener('click', () => close(c.id, button)); cell.append(button); rows.append(row);
    }
    empty.hidden = filtered.length > 0;
    empty.textContent = query ? '没有匹配的连接' : '暂无活动连接';
  }
  async function request(path, options = {}) {
    const response = await fetch(prefix + path, {credentials: 'same-origin', cache: 'no-store', ...options});
    if (response.status === 403) {
      const error = new Error('登录已过期，请重新进入设备管理登录。'); error.expired = true; throw error;
    }
    if (!response.ok) throw new Error('暂时无法读取或操作 Mihomo 连接。');
    return response.json();
  }
  async function refresh() {
    if (expired || document.hidden) return undefined;
    if (running && runningGen === generation) return running;
    const mine = generation;
    const task = (async () => {
      try {
        const data = await request('/connections/data');
        if (mine !== generation) return;
        snapshot = data; render();
        status.textContent = '每 2 秒更新 · ' + new Date().toLocaleTimeString(); status.dataset.error = 'false';
      } catch (error) {
        if (mine !== generation) return;
        if (error.expired) expired = true;
        status.textContent = error.message + (snapshot ? ' 当前显示上次成功的数据。' : ''); status.dataset.error = 'true';
      } finally { if (running === task) { running = null; runningGen = -1; } }
    })();
    running = task; runningGen = mine; return task;
  }
  function stop() {
    generation++; if (timer !== null) clearInterval(timer); timer = null;
  }
  function start() {
    if (expired || document.hidden) return;
    if (timer === null) timer = setInterval(refresh, 2000);
    refresh();
  }
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', start);
  window.addEventListener('pageshow', event => { if (event.persisted && snapshot && !expired) render(); });
  async function close(id, button) {
    button.disabled = true;
    try { await request('/connections/close', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({csrf: app.dataset.csrf, id})}); await refresh(); }
    catch (error) { if (error.expired) expired = true; status.textContent = error.message; status.dataset.error = 'true'; }
    finally { button.disabled = false; }
  }
  search.addEventListener('input', render);
  document.getElementById('connection-refresh').addEventListener('click', refresh);
  document.getElementById('connection-close-all').addEventListener('click', event => {
    if (confirm('断开当前全部连接？应用可能自动重新连接。')) close('all', event.currentTarget);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
  start();
})();
"""
