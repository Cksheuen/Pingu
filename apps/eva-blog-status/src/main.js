import { apiUrl, normalizeStatusInput, STATUS_KINDS } from "./statusContract.js";

const apiOrigin = document.querySelector("meta[name='eva-blog-author-api']")?.content || "http://127.0.0.1:4174";
const root = document.querySelector("#app");
let agentTimer = null;
let noticeTimer = null;
const state = {
  session: null,
  statuses: [],
  localSignals: null,
  localSignalsLoading: false,
  agent: { status: "not-configured" },
  agentLoading: false,
  daemonToken: null,
  kind: "activity",
  notice: "",
  error: "",
  errorRetryable: false,
  retryAction: null,
  loading: true
};

render();
await refresh();

async function refresh() {
  state.loading = true;
  render();
  try {
    const [session, statuses, agent] = await Promise.all([request("/api/session"), request("/api/status"), requestLocalAgent()]);
    state.session = session.user && session.author ? session.user : null;
    state.statuses = Array.isArray(statuses) ? statuses : [];
    state.agent = agent;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.errorRetryable = Boolean(error?.network);
    if (state.errorRetryable) state.retryAction = refresh;
  } finally {
    state.loading = false;
    render();
    scheduleAgentPoll();
  }
}

function render() {
  const oauthUrl = `${apiUrl(apiOrigin, "/api/auth/github/start")}?redirect=${encodeURIComponent(window.location.href)}`;
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">
        <img class="brand-mark" src="/public/assets/blog-cover.png" alt="">
        <span><strong>Eva Status Publisher</strong><small>local author device</small></span>
      </a>
      <div class="private-label"><span class="signal-dot"></span> Not public</div>
      ${state.session ? `<button class="ghost-button" data-action="logout" type="button">@${escapeHtml(state.session.login)} · Sign out</button>` : `<a class="oauth-link" href="${escapeAttr(oauthUrl)}">Authorize with GitHub</a>`}
    </header>
    ${state.notice ? `<div class="banner success" role="status">${escapeHtml(state.notice)}</div>` : ""}
    ${state.error ? `<div class="banner error" role="alert"><span>${escapeHtml(state.error)}</span>${state.errorRetryable ? `<button class="banner-retry" data-action="retry" type="button">Retry</button>` : ""}</div>` : ""}
    <main class="status-main">
      <section class="status-hero">
        <div>
          <p class="eyebrow">LOCAL SIGNAL / 04</p>
          <h1>What is happening now?</h1>
          <p class="lede">A quiet control room for the author channel. Read what is happening on this device, send one deliberate pulse, or hand the work to a low-memory background agent.</p>
        </div>
        <div class="api-readout"><span>AUTHOR API</span><strong>${escapeHtml(apiOrigin.replace(/^https?:\/\//, ""))}</strong><small>${state.loading ? "checking session…" : state.session ? "author session ready" : "authorization required"}</small></div>
      </section>
      <section class="status-layout">
        <form class="status-panel" data-form="status" novalidate>
          <div class="section-title"><div><p class="eyebrow">PUBLIC SIGNAL</p><h2>Sync a status</h2></div><span class="signal-count">${state.statuses.length}</span></div>
          <div class="source-toolbar">
            <div><strong>Device snapshot</strong><small>Fresh probe · Apple Music / Spotify + Codex usage</small></div>
            <button class="ghost-button" data-action="read-local" type="button" ${state.localSignalsLoading ? "disabled" : ""}>${state.localSignalsLoading ? "Reading…" : "Probe now"}</button>
          </div>
          ${localSignalMarkup()}
          ${agentMarkup()}
          <label class="field"><span>Signal type</span><select name="kind" data-field="kind">${STATUS_KINDS.map((kind) => `<option value="${kind}" ${kind === state.kind ? "selected" : ""}>${kindLabel(kind)}</option>`).join("")}</select></label>
          <label class="field"><span>Title</span><input name="title" placeholder="Current song, place, or work" required></label>
          <section class="kind-fields" data-kind-section="song">
            <div class="field-section-title"><span>NOW PLAYING</span><small>Structured music metadata</small></div>
            <div class="field-grid">
              <label class="field"><span>Artist</span><input name="artist" placeholder="Artist or creator"></label>
              <label class="field"><span>Album</span><input name="album" placeholder="Album or release"></label>
              <label class="field"><span>Service</span><input name="service" placeholder="Apple Music / Spotify"></label>
              <label class="field"><span>Playback</span><select name="playing"><option value="true">Playing</option><option value="false">Paused</option></select></label>
            </div>
            <label class="field"><span>Track URL</span><input name="url" type="url" placeholder="https://…"></label>
            <label class="field"><span>Artwork URL</span><input name="artworkUrl" type="url" placeholder="Optional image URL"></label>
          </section>
          <section class="kind-fields" data-kind-section="token">
            <div class="field-section-title"><span>CONTEXT WINDOW</span><small>Token usage stays private by default</small></div>
            <div class="field-grid">
              <label class="field"><span>Used tokens</span><input name="usedTokens" type="number" min="0" step="1" placeholder="128000"></label>
              <label class="field"><span>Token limit</span><input name="limitTokens" type="number" min="0" step="1" placeholder="256000"></label>
              <label class="field"><span>Provider</span><input name="provider" placeholder="OpenAI / Anthropic"></label>
              <label class="field"><span>Model</span><input name="model" placeholder="Model name"></label>
            </div>
            <div class="field-grid">
              <label class="field"><span>Window</span><input name="window" placeholder="Current task / daily budget"></label>
              <label class="field"><span>Reset at</span><input name="resetAt" type="datetime-local"></label>
            </div>
          </section>
          <label class="field"><span>Details</span><textarea name="details" rows="4" placeholder="One short line of context"></textarea></label>
          <label class="field"><span>Source</span><input name="source" value="local-device"></label>
          <label class="check-row"><input name="isPublic" type="checkbox" checked><span>Visible on public blog</span></label>
          <div class="form-error-summary" data-form-error role="alert" hidden></div>
          <button type="submit" ${state.session ? "" : "disabled"}>Publish to reader</button>
          ${state.session ? `<small class="form-footnote">Publishing as @${escapeHtml(state.session.login)}</small>` : `<p class="form-footnote">Authorize with GitHub to enable status publishing.</p>`}
        </form>
        <section class="status-history">
          <div class="section-title"><div><p class="eyebrow">RECENT PULSES</p><h2>Public history</h2></div><button class="ghost-button" data-action="refresh" type="button">Refresh</button></div>
          ${state.statuses.length ? state.statuses.map(statusItem).join("") : `<div class="empty-state">No public pulse yet. This panel will show the latest status after the first sync.</div>`}
        </section>
      </section>
    </main>
    <footer class="app-footer"><span>Local-only publisher · writes stay behind author API</span><span>4175</span></footer>
  `;
  bindActions();
  setKindFields(root.querySelector("[data-form='status']"), state.kind);
  if (state.notice) scheduleNoticeDismiss();
}

function scheduleNoticeDismiss() {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.notice = "";
    root.querySelector(".banner.success")?.remove();
  }, 3000);
}

function bindActions() {
  const form = root.querySelector("[data-form='status']");
  form?.elements.isPublic?.addEventListener("change", (event) => { event.currentTarget.dataset.userChanged = "true"; });
  form?.elements.kind?.addEventListener("change", (event) => {
    state.kind = event.currentTarget.value;
    setKindFields(form, state.kind);
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const currentForm = event.currentTarget;
    const errors = validateForm(currentForm);
    if (errors) {
      showFieldErrors(currentForm, errors);
      return;
    }
    clearFieldErrors(currentForm);
    const submitButton = currentForm.querySelector("button[type=submit]");
    const body = Object.fromEntries(new FormData(currentForm).entries());
    body.playing = currentForm.elements.playing?.value !== "false";
    body.isPublic = currentForm.elements.isPublic.checked;
    setButtonLoading(submitButton, true, "Publishing…");
    runAction(async () => {
      await request("/api/status", { method: "POST", body: normalizeStatusInput(body) });
      currentForm.reset();
      currentForm.elements.source.value = "local-device";
      currentForm.elements.isPublic.checked = true;
      state.kind = "activity";
      state.notice = "Status synced to Eva Blog.";
      await refresh();
    }).finally(() => setButtonLoading(submitButton, false));
  });
  form?.addEventListener("input", (event) => clearFieldError(event.target));
  root.querySelector("[data-action='read-local']")?.addEventListener("click", () => runAction(readLocalSignals));
  root.querySelector("[data-action='connect-agent']")?.addEventListener("click", () => runAction(connectAgent));
  root.querySelector("[data-action='copy-agent-token']")?.addEventListener("click", () => runAction(copyAgentToken));
  root.querySelector("[data-action='apply-music']")?.addEventListener("click", () => applyMusicSignal());
  root.querySelector("[data-action='apply-token']")?.addEventListener("click", () => applyTokenSignal());
  root.querySelector("[data-action='refresh']")?.addEventListener("click", () => runAction(refresh));
  root.querySelector("[data-action='retry']")?.addEventListener("click", () => {
    const retry = state.retryAction;
    if (retry) runAction(retry);
  });
  root.querySelector("[data-action='logout']")?.addEventListener("click", () => runAction(async () => {
    await request("/api/logout", { method: "POST" });
    state.session = null;
    state.notice = "Signed out.";
  }));
}

async function readLocalSignals() {
  state.localSignalsLoading = true;
  render();
  try {
    state.localSignals = await requestLocalSignals();
    state.notice = "Local signals read. Choose which one to sync.";
  } finally {
    state.localSignalsLoading = false;
  }
}

async function requestLocalSignals() {
  return fetchJson("/api/local/signals", { cache: "no-store", errorPrefix: "Local signal bridge" });
}

async function requestLocalAgent() {
  return fetchJson("/api/local/agent", { cache: "no-store", errorPrefix: "Local agent bridge" });
}

async function refreshAgent() {
  try { state.agent = await requestLocalAgent(); } catch { state.agent = { status: "unavailable" }; }
  render();
  scheduleAgentPoll();
}

function scheduleAgentPoll() {
  if (agentTimer) clearTimeout(agentTimer);
  agentTimer = setTimeout(refreshAgent, 15_000);
}

async function connectAgent() {
  if (!state.session) throw new Error("Authorize with GitHub before connecting the background agent.");
  state.agentLoading = true;
  render();
  try {
    state.daemonToken = await request("/api/status/daemon-token", { method: "POST" });
    state.notice = "Setup token ready. Copy it into the local agent command below.";
  } finally {
    state.agentLoading = false;
  }
}

async function copyAgentToken() {
  const token = state.daemonToken?.token;
  if (!token) return;
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Copy the token from the setup panel manually.");
  await navigator.clipboard.writeText(token);
  state.notice = "Setup token copied. It is shown only in this private author screen.";
}

function applyMusicSignal() {
  const signal = state.localSignals?.nowPlaying;
  const form = root.querySelector("[data-form='status']");
  if (!signal || !form) return;
  state.kind = "song";
  form.elements.kind.value = "song";
  setKindFields(form, "song");
  form.elements.title.value = signal.track || "";
  form.elements.artist.value = signal.artist || "";
  form.elements.album.value = signal.album || "";
  form.elements.service.value = signal.service || "local player";
  form.elements.playing.value = signal.playing === false ? "false" : "true";
  form.elements.source.value = signal.service || "local-device";
  state.notice = "Current music loaded into the sync form.";
}

function applyTokenSignal() {
  const signal = state.localSignals?.tokenUsage;
  const form = root.querySelector("[data-form='status']");
  if (!signal || !form) return;
  state.kind = "token";
  form.elements.kind.value = "token";
  setKindFields(form, "token");
  form.elements.title.value = "Token usage";
  form.elements.usedTokens.value = signal.usedTokens ?? "";
  form.elements.limitTokens.value = signal.limitTokens ?? "";
  form.elements.provider.value = signal.provider || "";
  form.elements.model.value = signal.model || "";
  form.elements.window.value = signal.window || "";
  form.elements.resetAt.value = toDateTimeLocal(signal.resetAt);
  form.elements.source.value = signal.provider || "local-token-source";
  form.elements.isPublic.checked = false;
  state.notice = "Token usage loaded. It remains private unless you enable public visibility.";
}

function setKindFields(form, kind) {
  if (!form) return;
  form.querySelectorAll("[data-kind-section]").forEach((section) => { section.hidden = section.dataset.kindSection !== kind; });
  form.elements.title.placeholder = kind === "song" ? "Track name" : kind === "token" ? "Token usage" : "Current place, work, or activity";
  form.elements.title.required = kind !== "token";
  if (kind === "token" && form.elements.isPublic.dataset.userChanged !== "true") form.elements.isPublic.checked = false;
  if (kind !== "token" && form.elements.isPublic.dataset.userChanged !== "true") form.elements.isPublic.checked = true;
}

function localSignalMarkup() {
  if (!state.localSignals) return `<div class="local-signal-empty">Probe the device to check the active player and the local Codex or snapshot token source.</div>`;
  const music = state.localSignals.nowPlaying;
  const token = state.localSignals.tokenUsage;
  return `<div class="local-signal-grid">
    <article class="local-signal-card"><span class="signal-kind">NOW PLAYING</span><strong>${music ? escapeHtml([music.track, music.artist].filter(Boolean).join(" · ")) : "No active player"}</strong><small>${music ? escapeHtml(music.service || "local player") : "Apple Music / Spotify not playing"}</small>${music ? `<button class="text-button" data-action="apply-music" type="button">Use music signal</button>` : ""}</article>
    <article class="local-signal-card"><span class="signal-kind">TOKEN USAGE</span><strong>${token ? escapeHtml(formatTokenUsage(token)) : "No token source"}</strong><small>${token ? escapeHtml([token.provider, token.model].filter(Boolean).join(" · ") || "local counter") : "Codex session or local snapshot unavailable"}</small>${token ? `<button class="text-button" data-action="apply-token" type="button">Use token signal</button>` : ""}</article>
  </div>`;
}

function agentMarkup() {
  const agent = state.agent || {};
  const running = agent.status === "running";
  const healthy = running && agent.lastSuccessAt;
  const setup = state.daemonToken;
  return `<section class="agent-panel" aria-label="Background agent">
    <div class="agent-heading"><div><span class="signal-kind">BACKGROUND AGENT</span><strong>${running ? "Running quietly" : agent.status === "error" ? "Needs attention" : "Not connected"}</strong><small>${healthy ? `Last report ${formatDate(agent.lastSuccessAt)}` : agent.lastError ? escapeHtml(agent.lastError) : "One process · one timer · no browser required"}</small></div><span class="agent-state ${running ? "live" : agent.status === "error" ? "error" : "idle"}">${running ? "LIVE" : agent.status === "error" ? "ERROR" : "IDLE"}</span></div>
    ${agent.lastSuccessAt ? `<div class="agent-facts"><span><b>Last cycle</b>${formatDate(agent.lastSuccessAt)}</span><span><b>Sent</b>${escapeHtml(agent.synced?.join(" + ") || "none")}</span></div>` : ""}
    ${setup ? `<div class="agent-setup"><p>Run this in the status app directory. The token is short-lived and stays local to the CLI.</p><code>printf '%s' '&lt;copied-token&gt;' | pnpm daemon configure --token-stdin</code><details class="agent-token"><summary>Reveal setup token</summary><code>${escapeHtml(setup.token)}</code></details><div class="agent-setup-actions"><button class="ghost-button" data-action="copy-agent-token" type="button">Copy setup token</button><small>expires ${formatUnixDate(setup.expiresAt)}</small></div></div>` : ""}
    <button class="agent-connect" data-action="connect-agent" type="button" ${state.agentLoading || !state.session ? "disabled" : ""}>${state.agentLoading ? "Issuing token…" : running ? "Issue another setup token" : "Connect background agent"}</button>
  </section>`;
}

function statusItem(status) {
  const label = status.kind === "song" ? status.meta?.playing === false ? "Paused" : "Listening" : status.kind === "work" ? "Working" : status.kind === "token" ? "Token usage" : "Active";
  const title = status.kind === "song" ? [status.meta?.track || status.title, status.meta?.artist].filter(Boolean).join(" · ") : status.kind === "token" ? formatTokenUsage(status.meta) : status.title;
  const tokenMeter = status.kind === "token" ? tokenMeterMarkup(status.meta) : "";
  return `<article class="status-item"><div class="status-item-top"><span class="status-kind">${label}</span><time>${formatDate(status.updatedAt)}</time></div><h3>${escapeHtml(title)}</h3>${tokenMeter}${status.details ? `<p>${escapeHtml(status.details)}</p>` : ""}<small>${escapeHtml(status.source || "local-device")} · @${escapeHtml(status.actor?.login || "author")}</small></article>`;
}

function tokenMeterMarkup(meta = {}) {
  const percentage = meta.usagePercent !== undefined
    ? meta.usagePercent
    : meta.limitTokens === undefined
      ? null
      : Math.min(100, Math.round((meta.usedTokens / meta.limitTokens) * 100));
  if (percentage === null) return "";
  const label = meta.usagePercent !== undefined ? `${percentage}% used` : `${percentage}% used · ${formatTokenCount(meta.usedTokens)} / ${formatTokenCount(meta.limitTokens)}`;
  return `<div class="token-meter" aria-label="${percentage}% token usage"><span style="width:${percentage}%"></span></div><small class="token-meter-label">${label}</small>`;
}

function formatTokenUsage(meta = {}) {
  if (meta.usagePercent !== undefined) return `${meta.usagePercent}% used`;
  const used = formatTokenCount(meta.usedTokens);
  const limit = meta.limitTokens === undefined ? "" : ` / ${formatTokenCount(meta.limitTokens)}`;
  return `${used}${limit} ${meta.unit || "tokens"}`;
}

function formatTokenCount(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

async function runAction(action) {
  state.error = "";
  state.errorRetryable = false;
  state.notice = "";
  try {
    state.retryAction = action;
    await action();
    state.retryAction = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.errorRetryable = Boolean(error?.network);
  }
  render();
}

async function request(path, options = {}) {
  return fetchJson(apiUrl(apiOrigin, path), {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
    errorPrefix: "Author API"
  });
}

async function fetchJson(url, { errorPrefix, ...options } = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    const host = new URL(url, window.location.href).host;
    const error = new Error(`Cannot reach ${host}. Check that the local service is running, then retry.`);
    error.network = true;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${errorPrefix || "Service"} returned ${response.status}.`);
  return payload;
}

function validateForm(form) {
  const errors = {};
  const kind = form.elements.kind.value;
  const title = form.elements.title.value.trim();
  if (kind !== "token" && !title) errors.title = "Title is required.";
  if (kind === "song") {
    for (const name of ["url", "artworkUrl"]) {
      const value = form.elements[name].value.trim();
      if (value && !isHttpUrl(value)) errors[name] = "Enter a valid http(s) URL.";
    }
  }
  if (kind === "token") {
    const usedRaw = form.elements.usedTokens.value;
    const used = Number(usedRaw);
    if (usedRaw === "" || !Number.isFinite(used) || used < 0) {
      errors.usedTokens = "Used tokens is required.";
    }
    const limitRaw = form.elements.limitTokens.value;
    if (limitRaw !== "") {
      const limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit < 0) {
        errors.limitTokens = "Enter a valid number.";
      } else if (!errors.usedTokens && limit < used) {
        errors.limitTokens = "Limit must be greater than or equal to used tokens.";
      }
    }
  }
  return Object.keys(errors).length ? errors : null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function showFieldErrors(form, errors) {
  clearFieldErrors(form);
  for (const [name, message] of Object.entries(errors)) {
    const field = form.elements[name];
    if (!field) continue;
    const wrapper = field.closest(".field") || field;
    wrapper.classList.add("field-has-error");
    field.setAttribute("aria-invalid", "true");
    const note = document.createElement("small");
    note.className = "field-error";
    note.textContent = message;
    wrapper.appendChild(note);
  }
  const summary = form.querySelector("[data-form-error]");
  if (summary) {
    const count = Object.keys(errors).length;
    summary.textContent = `Please fix ${count} field${count > 1 ? "s" : ""} above.`;
    summary.hidden = false;
  }
}

function clearFieldErrors(form) {
  form.querySelectorAll(".field-has-error").forEach((element) => element.classList.remove("field-has-error"));
  form.querySelectorAll("[aria-invalid]").forEach((element) => element.removeAttribute("aria-invalid"));
  form.querySelectorAll(".field-error").forEach((element) => element.remove());
  const summary = form.querySelector("[data-form-error]");
  if (summary) {
    summary.textContent = "";
    summary.hidden = true;
  }
}

function clearFieldError(field) {
  const wrapper = field?.closest?.(".field");
  wrapper?.classList.remove("field-has-error");
  field?.removeAttribute?.("aria-invalid");
  wrapper?.querySelector(".field-error")?.remove();
  const form = field?.form;
  if (form && !form.querySelector(".field-error")) {
    const summary = form.querySelector("[data-form-error]");
    if (summary) {
      summary.textContent = "";
      summary.hidden = true;
    }
  }
}

function setButtonLoading(button, loading, loadingText) {
  if (!button) return;
  if (loading) {
    button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escapeHtml(loadingText)}`;
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.textContent = button.dataset.idleLabel || "Publish to reader";
    delete button.dataset.idleLabel;
  }
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatUnixDate(value) { return value ? formatDate(new Date(Number(value) * 1000).toISOString()) : "—"; }

function kindLabel(kind) { return kind === "song" ? "Now playing" : kind === "token" ? "Token usage" : kind[0].toUpperCase() + kind.slice(1); }
function toDateTimeLocal(value) { return value ? String(value).slice(0, 16) : ""; }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#096;"); }
