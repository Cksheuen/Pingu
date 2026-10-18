const $ = id => document.getElementById(id);
let password = '', cursor = null, records = new Map(), createdAddress = '';
function notice(text = '', error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function logout() {
  password = ''; records.clear(); createdAddress = ''; cursor = null;
  $('password').value = ''; $('created').hidden = true; $('addresses').replaceChildren();
  $('destination').textContent = ''; $('created-address').textContent = ''; $('label').value = '';
  $('workspace').hidden = true; $('logout').hidden = true; $('login-panel').hidden = false;
}
async function api(path, options = {}) {
  const response = await fetch('/generator/api' + path, {
    ...options, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + password, 'Content-Type': 'application/json' },
  });
  const data = await response.json();
  if (response.status === 401) logout();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function action(button, fn) {
  button.disabled = true; notice();
  try { await fn(); } catch (error) { notice(error.message || '网络连接失败', true); }
  finally { button.disabled = false; }
}
async function copy(address) {
  try { await navigator.clipboard.writeText(address); notice('已复制：' + address); }
  catch { notice('复制失败，请手动选中并复制邮箱地址。', true); }
}
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className || ''; if (text !== undefined) node.textContent = text; return node;
}
function render() {
  const list = $('addresses'); list.replaceChildren(); $('count').textContent = String(records.size);
  if (!records.size) list.append(element('div', 'empty', '还没有地址。为第一个用途生成一个吧。'));
  for (const record of [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const row = element('article', 'address-card');
    const info = element('div', 'address-info');
    info.append(element('div', 'address-name', record.address));
    const meta = element('div', 'address-meta');
    meta.append(element('span', 'pill' + (record.enabled ? '' : ' disabled'), record.enabled ? '转发已启用' : '已停用'));
    meta.append(element('span', '', record.label || '未填写用途'));
    meta.append(element('span', '', new Date(record.created_at).toLocaleDateString())); info.append(meta);
    const actions = element('div', 'actions');
    const copyButton = element('button', 'quiet', '复制'); copyButton.setAttribute('aria-label', '复制 ' + record.address); copyButton.onclick = () => copy(record.address);
    const toggle = element('button', 'quiet', record.enabled ? '停用' : '启用');
    toggle.setAttribute('aria-label', (record.enabled ? '停用 ' : '启用 ') + record.address);
    toggle.onclick = () => action(toggle, async () => {
      const updated = await api('/address', { method: 'PATCH', body: JSON.stringify({ address: record.address, enabled: !record.enabled }) });
      records.set(updated.address, updated); render(); notice('状态已保存；配置同步通常需要约一分钟，有时更久。');
    });
    actions.append(copyButton, toggle); row.append(info, actions); list.append(row);
  }
  $('more').hidden = !cursor;
}
async function load(more = false) {
  const data = await api('/addresses' + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  if (!more) records.clear();
  data.results.forEach(r => records.set(r.address, r)); cursor = data.cursor; render();
}
$('login-form').onsubmit = event => {
  event.preventDefault();
  action(event.submitter, async () => {
    password = $('password').value;
    const config = await api('/config');
    $('password').value = ''; $('domain').replaceChildren(...config.domains.map(d => { const option = document.createElement('option'); option.value = d; option.textContent = '@' + d; return option; }));
    $('destination').textContent = config.destination || '待配置';
    $('generate').disabled = !config.ready || !config.domains.length;
    $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    await load(); if (!config.ready) notice('转发目标尚未配置，请先完成服务配置。', true);
  });
};
$('generate-form').onsubmit = event => {
  event.preventDefault();
  action(event.submitter, async () => {
    const record = await api('/addresses', { method: 'POST', body: JSON.stringify({ prefix: $('prefix').value, label: $('label').value, domain: $('domain').value }) });
    createdAddress = record.address; records.set(record.address, record); render();
    $('created-address').textContent = record.address; $('created').hidden = false; $('label').value = '';
    notice('新地址已生成。');
  });
};
$('logout').onclick = () => { logout(); notice('已退出登录。'); };
$('copy-created').onclick = () => copy(createdAddress);
$('refresh').onclick = event => action(event.currentTarget, () => load());
$('more').onclick = event => action(event.currentTarget, () => load(true));
