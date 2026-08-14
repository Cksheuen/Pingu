import { createAuthorController } from "./authorController.js";
import { ARTICLE_STATUSES } from "./domain/blog.js";
import { createAuthorApi } from "./services/authorApi.js";

const statusOrigin = readOrigin("eva-blog-status-origin", "http://127.0.0.1:4175");
const publicOrigin = readOrigin("eva-blog-public-origin", "http://127.0.0.1:4173");
const root = document.querySelector("#app");
const controller = createAuthorController({ api: createAuthorApi() });

const AUTOSAVE_INTERVAL_MS = 30000;
const draftSession = { articleId: "", baseline: "", dirty: false };
let preservedDraft = null;
let publishConfirmOpen = false;

controller.subscribe(render);
render(controller.getState());
bindEditorSession();
await controller.initialize();

function render(state) {
  const article = state.selectedArticle || {};
  const canEdit = state.authorized && !state.busy;
  const title = state.selectedArticle ? "Writing desk" : "New entry";
  const submitLabel = state.selectedArticle ? "Save changes" : "Save draft";

  captureDraftBeforeRender();
  root.innerHTML = `
    <header class="studio-topbar">
      <a class="brand" href="/" aria-label="Eva Author Workspace home">
        <img class="brand-mark" src="/public/assets/blog-cover.png" alt="">
        <span><strong>Eva Author Workspace</strong><small>PRIVATE PUBLISHING CHANNEL</small></span>
      </a>
      <div class="private-signal"><span class="signal-dot"></span><span>Private host · GitHub gate</span></div>
      <div class="author-access">
        <a class="console-link" href="${escapeAttr(statusOrigin)}">Status console ↗</a>
        ${authorizationControl(state)}
      </div>
    </header>
    ${state.notice ? notification("success", state.notice) : ""}
    ${state.error ? notification("error", state.error) : ""}
    <main class="studio-main">
      <aside class="library-panel" aria-labelledby="archive-title">
        <div class="panel-kicker">ARTICLE ARCHIVE / ${String(state.articles.length).padStart(2, "0")}</div>
        <div class="library-heading">
          <div>
            <h1 id="archive-title">Your working set</h1>
            <p>Drafts and published notes stay on this private author host.</p>
          </div>
          <button class="icon-button" data-action="new-article" type="button" ${canEdit ? "" : "disabled"} aria-label="Start a new article">+</button>
        </div>
        <div class="archive-divider"></div>
        <div class="article-list" aria-busy="${state.loading}">
          ${inventoryContent(state)}
        </div>
        <div class="library-footnote">
          <span class="signal-dot"></span>
          <span>Public readers never receive this archive endpoint.</span>
        </div>
      </aside>

      <section class="composer-panel" aria-labelledby="desk-title">
          <div class="composer-heading">
          <div>
            <p class="panel-kicker">ENTRY / ${state.selectedArticle ? escapeHtml(state.selectedArticle.id.slice(-6).toUpperCase()) : "UNSAVED"}</p>
            <h2 id="desk-title">${title}</h2>
          </div>
          <div class="composer-heading-actions"><button class="preview-toggle" type="button" data-action="toggle-preview" ${canEdit ? "" : "disabled"}>${state.previewMode ? "Close preview" : "Preview privately"}</button><div class="editor-state ${article.status || "draft"}"><span></span>${escapeHtml(article.status || "draft")}</div></div>
        </div>
        <p class="access-note">${accessNote(state)}</p>
        <form class="article-form" data-form="article">
          <fieldset ${canEdit ? "" : "disabled"}>
            <input type="hidden" name="id" value="${escapeAttr(article.id || "")}">
            <label class="title-field">
              <span>Headline</span>
              <input name="title" value="${escapeAttr(article.title || "")}" placeholder="Give the entry a clear name" required autocomplete="off">
            </label>
            <div class="metadata-grid metadata-grid-wide">
              <label class="field">
                <span>Reader path</span>
                <input name="slug" value="${escapeAttr(article.slug || "")}" placeholder="Generated from headline" autocomplete="off">
              </label>
              <label class="field">
                <span>Index tags</span>
                <input name="tags" value="${escapeAttr((article.tags || []).join(", "))}" placeholder="notes, research, release" autocomplete="off">
              </label>
              <label class="field">
                <span>Lifecycle</span>
                <select name="status">
                  ${["draft", "scheduled", "published", "unpublished"].map((status) => `<option value="${status}" ${article.status === status ? "selected" : ""}>${status}</option>`).join("")}
                </select>
              </label>
              <label class="field">
                <span>Scheduled time</span>
                <input type="datetime-local" name="scheduledAt" value="${escapeAttr(toLocalDateTime(article.scheduledAt))}">
              </label>
              <label class="field">
                <span>Series title</span>
                <input name="seriesTitle" value="${escapeAttr(article.series?.title || "")}" placeholder="Optional sequence">
              </label>
              <label class="field">
                <span>Series order</span>
                <input type="number" min="0" name="seriesOrder" value="${escapeAttr(article.series?.order ?? "")}" placeholder="01">
              </label>
            </div>
            <label class="field field-wide">
              <span>Related reader paths</span>
              <input name="relatedSlugs" value="${escapeAttr((article.relatedSlugs || []).join(", "))}" placeholder="another-note, field-guide">
            </label>
            <label class="field field-wide">
              <span>Search description</span>
              <input name="seoDescription" value="${escapeAttr(article.seoDescription || "")}" placeholder="A concise description for search and sharing">
            </label>
            <div class="source-row">
              <label class="file-field">
                <span>Bring a Markdown file</span>
                <input type="file" data-field="markdown-file" accept=".md,.markdown,text/markdown,text/plain">
              </label>
              <p>Import creates a new private draft, so the current entry remains intact.</p>
            </div>
            <label class="writer-field">
              <span>Manuscript <small>Markdown supported</small></span>
              <textarea name="content" rows="22" placeholder="# Start writing&#10;&#10;Keep the source close to the thought." required>${escapeHtml(article.content || "")}</textarea>
            </label>
            <div class="composer-actions">
              <div class="save-state">${state.busy ? "Saving to private archive…" : article.updatedAt ? `Last saved ${formatDate(article.updatedAt)}` : "Not saved yet"}</div>
              <div class="action-cluster">
                <button class="quiet-button" type="submit" data-submit-mode="save">${submitLabel}</button>
                ${article.status === ARTICLE_STATUSES.PUBLISHED
                  ? `<span class="published-confirmation">Reader live</span>`
                  : `<button class="publish-button" type="submit" data-submit-mode="publish">Publish to reader</button>`}
              </div>
            </div>
          </fieldset>
        </form>
        ${state.previewMode ? privatePreview(article) : ""}
      </section>

      <aside class="publication-panel" aria-labelledby="publication-title">
        ${publicationContent(article, state)}
      </aside>

      <section class="gallery-desk" aria-labelledby="gallery-title">
        <div class="gallery-desk-heading">
          <div>
            <p class="panel-kicker">SKETCHBOOK / ${String(state.artworks.length).padStart(2, "0")}</p>
            <h2 id="gallery-title">Gallery desk</h2>
            <p>Keep the visual work in its own folio: original files private, display derivatives reader-safe.</p>
          </div>
          <span class="folio-mark">✳ / visual notes</span>
        </div>
        <div class="gallery-layout">
          <form class="artwork-form" data-form="artwork">
            <fieldset ${canEdit ? "" : "disabled"}>
              <label class="title-field"><span>Artwork title</span><input name="title" placeholder="Name the piece" required></label>
              <div class="metadata-grid">
                <label class="field"><span>Image URL / derivative</span><input name="publicSrc" placeholder="/public/assets/sketch-orbit.svg"></label>
                <label class="field"><span>Alt text</span><input name="altText" placeholder="Describe what is drawn" required></label>
                <label class="field"><span>Medium</span><input name="medium" value="ink and digital wash"></label>
                <label class="field"><span>Related article</span><input name="relatedArticleSlug" placeholder="optional-reader-path"></label>
              </div>
              <label class="file-field artwork-file-field"><span>Or prepare a local drawing</span><input type="file" data-field="artwork-file" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label>
              ${state.pendingArtworkAsset ? `<p class="upload-ready">Derivative ready · ${escapeHtml(state.pendingArtworkAsset.mimeType || "image/webp")}</p>` : ""}
              <label class="field field-wide"><span>Artist note</span><textarea name="artistNote" rows="3" placeholder="What should the reader notice first?"></textarea></label>
              <label class="field field-wide"><span>Caption</span><input name="caption" placeholder="A short line beneath the image"></label>
              <div class="composer-actions">
                <span class="save-state">${state.authorized ? "Private studio ready" : "Author access required"}</span>
                <div class="action-cluster"><button class="quiet-button" type="submit" data-submit-mode="save-artwork">Save sketch</button><button class="publish-button" type="submit" data-submit-mode="publish-artwork">Hang in gallery</button></div>
              </div>
            </fieldset>
          </form>
          <div class="artwork-contact-sheet">${galleryContent(state)}</div>
        </div>
      </section>
    </main>
    <footer class="app-footer">
      <span>Private author workspace · status publishing stays in the local status app</span>
      <a href="/public/handoff/local-runbook.md">Private runbook ↗</a>
    </footer>
  `;

  bindActions();
}

function authorizationControl(state) {
  if (state.authorized) {
    return `<span class="session-chip">@${escapeHtml(state.session?.login || "author")}</span><button class="sign-out" data-action="logout" type="button" ${state.busy ? "disabled" : ""}>Sign out</button>`;
  }

  return `<a class="authorize-link" href="/api/auth/github/start?redirect=/">Continue with GitHub</a>`;
}

function inventoryContent(state) {
  if (state.loading) {
    return emptyState("Checking private author access…");
  }
  if (!state.authorized) {
    return `<div class="access-state"><span class="access-state-number">01</span><p>${accessNote(state)}</p></div>`;
  }
  if (!state.articles.length) {
    return emptyState("No entries yet. Start with a short draft or import an existing Markdown note.");
  }

  return state.articles.map((article) => articleItem(article, state.selectedArticle?.id === article.id)).join("");
}

function articleItem(article, selected) {
  return `
    <button class="archive-item ${selected ? "selected" : ""}" data-action="edit-article" data-id="${escapeAttr(article.id)}" type="button">
      <span class="archive-item-index">${article.status === ARTICLE_STATUSES.PUBLISHED ? "PUBLIC" : "DRAFT"}</span>
      <span class="archive-item-copy">
        <strong>${escapeHtml(article.title)}</strong>
        <small>${formatDate(article.updatedAt)} · ${article.readingMinutes || 1} min</small>
      </span>
      <span class="archive-item-marker" aria-hidden="true"></span>
    </button>
  `;
}

function publicationContent(article, state) {
  const isPublished = article.status === ARTICLE_STATUSES.PUBLISHED;
  const publicArticleUrl = article.slug
    ? `${publicOrigin}#/article/${encodeURIComponent(article.slug)}`
    : publicOrigin;
  const summary = article.summary?.text || article.excerpt || "A concise reader excerpt will appear after the first save.";

  const quality = state.quality;
  return `
    <div class="panel-kicker">PUBLICATION LEDGER</div>
    <div class="publication-heading">
      <div>
        <h2 id="publication-title">${isPublished ? "Reader route active" : "Private until you say so"}</h2>
        <p>${isPublished ? "This entry is visible in the separate public reader." : "Saving stores a draft only. Publishing is an explicit second action."}</p>
      </div>
      <span class="status-pill ${isPublished ? "published" : "draft"}">${escapeHtml(article.status || "draft")}</span>
    </div>
      <div class="fact-list">
      <div><span>Visibility</span><strong>${isPublished ? "Public reader" : "Private archive"}</strong></div>
      <div><span>Reader time</span><strong>${article.readingMinutes || 1} min</strong></div>
      <div><span>Schedule</span><strong>${article.status === "scheduled" ? formatDate(article.scheduledAt) : "Manual"}</strong></div>
      <div><span>Updated</span><strong>${article.updatedAt ? formatDate(article.updatedAt) : "Not saved"}</strong></div>
    </div>
    <div class="reader-abstract">
      <span>Reader abstract</span>
      <p>${escapeHtml(summary)}</p>
    </div>
    <div class="reader-bridge">
      <span>Separate public surface</span>
      ${isPublished
        ? `<a href="${escapeAttr(publicArticleUrl)}" target="_blank" rel="noreferrer">Open reader preview ↗</a>`
        : `<p>Publish this entry to generate its reader route.</p>`}
    </div>
    ${quality ? `<div class="quality-check ${quality.ready ? "ready" : "needs-work"}"><span>${quality.ready ? "READY TO PUBLISH" : "PUBLISHING CHECK"}</span><p>${quality.ready ? "The reader contract has the minimum metadata it needs." : quality.issues.map((issue) => escapeHtml(issue.message)).join(" ")}</p></div>` : ""}
    ${state.revisions?.length ? `<div class="revision-stack"><span>Revision trail</span>${state.revisions.slice(0, 3).map((revision) => `<button type="button" data-action="restore-revision" data-revision-id="${escapeAttr(revision.id)}">${escapeHtml(revision.label)} · ${formatDate(revision.createdAt)}</button>`).join("")}</div>` : ""}
    ${isPublished ? `<button class="quiet-button full-button" type="button" data-action="unpublish-article" data-id="${escapeAttr(article.id)}">Unpublish from reader</button>` : ""}
    <div class="privacy-note"><span class="signal-dot"></span><p>Author tools, inventory, drafts, and GitHub session stay outside the public blog build.</p></div>
  `;
}

function galleryContent(state) {
  if (!state.artworks?.length) return emptyState("No sketches yet. Save a visual note to start the folio.");
  return state.artworks.map((artwork) => `
    <article class="artwork-tile ${artwork.status === "published" ? "is-live" : "is-private"}">
      <div class="artwork-tile-image">${artwork.assets?.[0]?.publicSrc ? `<img src="${escapeAttr(artwork.assets[0].publicSrc)}" alt="${escapeAttr(artwork.assets[0].altText || artwork.altText || artwork.title)}">` : `<span>${escapeHtml(artwork.title.slice(0, 1))}</span>`}</div>
      <div class="artwork-tile-copy"><strong>${escapeHtml(artwork.title)}</strong><small>${escapeHtml(artwork.medium || "visual note")} · ${escapeHtml(artwork.status)}</small><p>${escapeHtml(artwork.caption || artwork.artistNote || "No caption yet.")}</p></div>
      ${artwork.status === "published" ? `<button class="tile-action" type="button" data-action="unpublish-artwork" data-id="${escapeAttr(artwork.id)}">Unhang</button>` : `<button class="tile-action" type="button" data-action="publish-artwork" data-id="${escapeAttr(artwork.id)}">Hang</button>`}
    </article>
  `).join("");
}

function privatePreview(article) {
  return `<section class="private-preview" aria-label="Private reader preview"><div class="preview-bar"><span>PRIVATE READER PREVIEW</span><span>not indexed · not published</span></div><div class="preview-scroll" data-preview-scroll><article><p class="panel-kicker">${formatDate(article.updatedAt)} · ${article.readingMinutes || 1} min read</p><h2>${escapeHtml(article.title || "Untitled entry")}</h2><p class="preview-excerpt">${escapeHtml(article.excerpt || "The excerpt appears after the first save.")}</p><div class="preview-body">${renderAuthorMarkdown(article.content || "")}</div></article></div></section>`;
}

function renderAuthorMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  let listOpen = false;
  const html = [];
  for (const line of lines) {
    if (!line.trim()) { if (listOpen) { html.push("</ul>"); listOpen = false; } continue; }
    if (line.startsWith("```")) continue;
    if (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### ")) { if (listOpen) { html.push("</ul>"); listOpen = false; } const depth = Math.min(3, line.match(/^#+/)[0].length); html.push(`<h${depth}>${escapeHtml(line.slice(depth + 1))}</h${depth}>`); }
    else if (line.startsWith("- ")) { if (!listOpen) { html.push("<ul>"); listOpen = true; } html.push(`<li>${escapeHtml(line.slice(2))}</li>`); }
    else { if (listOpen) { html.push("</ul>"); listOpen = false; } html.push(`<p>${escapeHtml(line)}</p>`); }
  }
  if (listOpen) html.push("</ul>");
  return html.join("");
}

function bindActions() {
  const articleForm = root.querySelector("[data-form='article']");
  if (articleForm) bindArticleForm(articleForm);

  root.querySelector("[data-field='markdown-file']")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await controller.importMarkdown(file.name, await file.text());
    }
  });

  root.querySelectorAll("[data-action='edit-article']").forEach((button) => {
    button.addEventListener("click", () => controller.selectArticle(button.dataset.id));
  });
  root.querySelector("[data-action='new-article']")?.addEventListener("click", () => controller.startNewArticle());
  root.querySelector("[data-action='logout']")?.addEventListener("click", () => controller.logout());
  root.querySelector("[data-action='toggle-preview']")?.addEventListener("click", () => controller.togglePreview());
  root.querySelector("[data-action='unpublish-article']")?.addEventListener("click", (event) => controller.unpublishArticle(event.currentTarget.dataset.id));
  root.querySelectorAll("[data-action='restore-revision']").forEach((button) => button.addEventListener("click", () => controller.restoreRevision(controller.getState().selectedArticle.id, button.dataset.revisionId)));
  root.querySelectorAll("[data-action='publish-artwork']").forEach((button) => button.addEventListener("click", () => controller.publishArtwork(button.dataset.id)));
  root.querySelectorAll("[data-action='unpublish-artwork']").forEach((button) => button.addEventListener("click", () => controller.unpublishArtwork(button.dataset.id)));
  root.querySelector("[data-form='artwork']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (controller.getState().pendingArtworkAsset) input.assets = [controller.getState().pendingArtworkAsset];
    else if (input.publicSrc) input.assets = [{ id: "display-1", publicSrc: input.publicSrc, publicThumbSrc: input.publicSrc, altText: input.altText, kind: "image" }];
    delete input.publicSrc;
    controller.saveArtwork(input, { publish: event.submitter?.dataset.submitMode === "publish-artwork" });
  });
  root.querySelector("[data-field='artwork-file']")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const formData = await prepareArtworkUpload(file);
      await controller.uploadArtworkAsset(formData);
    } catch (error) {
      root.querySelector("[data-field='artwork-file']").setCustomValidity(error.message || "Could not prepare this image.");
      root.querySelector("[data-field='artwork-file']").reportValidity();
    }
  });
}

function bindArticleForm(form) {
  const renderedId = form.elements.namedItem("id")?.value || "";
  draftSession.articleId = renderedId;
  draftSession.baseline = serializeForm(form);
  draftSession.dirty = false;
  if (preservedDraft && preservedDraft.articleId === renderedId) {
    restoreFormValues(form, preservedDraft.values);
    draftSession.dirty = serializeForm(form) !== draftSession.baseline;
  }
  preservedDraft = null;

  const saveState = form.querySelector(".save-state");
  if (saveState) saveState.dataset.idleText = saveState.textContent;

  const textarea = form.elements.namedItem("content");
  const previewScroll = root.querySelector("[data-preview-scroll]");
  let scrollSyncing = false;
  const syncPreviewScroll = () => {
    if (!textarea || !previewScroll || scrollSyncing) return;
    const sourceRange = textarea.scrollHeight - textarea.clientHeight;
    const targetRange = previewScroll.scrollHeight - previewScroll.clientHeight;
    if (sourceRange <= 0 || targetRange <= 0) return;
    scrollSyncing = true;
    previewScroll.scrollTop = (textarea.scrollTop / sourceRange) * targetRange;
    requestAnimationFrame(() => requestAnimationFrame(() => { scrollSyncing = false; }));
  };
  if (textarea && previewScroll) {
    textarea.addEventListener("scroll", syncPreviewScroll, { passive: true });
    previewScroll.addEventListener("scroll", () => {
      if (scrollSyncing) return;
      const sourceRange = previewScroll.scrollHeight - previewScroll.clientHeight;
      const targetRange = textarea.scrollHeight - textarea.clientHeight;
      if (sourceRange <= 0 || targetRange <= 0) return;
      scrollSyncing = true;
      textarea.scrollTop = (previewScroll.scrollTop / sourceRange) * targetRange;
      requestAnimationFrame(() => requestAnimationFrame(() => { scrollSyncing = false; }));
    }, { passive: true });
    syncPreviewScroll();
  }

  if (draftSession.dirty && controller.getState().previewMode) updateLivePreview(form);

  form.addEventListener("input", () => {
    draftSession.dirty = serializeForm(form) !== draftSession.baseline;
    if (saveState) saveState.textContent = draftSession.dirty ? "Unsaved changes" : saveState.dataset.idleText;
    if (controller.getState().previewMode) {
      updateLivePreview(form);
      syncPreviewScroll();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitMode = event.submitter?.dataset.submitMode || "save";
    if (submitMode === "publish") {
      openPublishConfirm(form);
      return;
    }
    void saveArticleFromForm(form);
  });
}

function bindEditorSession() {
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || publishConfirmOpen) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      saveCurrentArticle();
    } else if (key === "p") {
      event.preventDefault();
      controller.togglePreview();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!draftSession.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  setInterval(() => {
    if (!draftSession.dirty || publishConfirmOpen) return;
    const state = controller.getState();
    if (!state.authorized || state.busy) return;
    const form = root.querySelector("[data-form='article']");
    if (!form) return;
    const input = Object.fromEntries(new FormData(form).entries());
    if (!input.title?.trim() || !input.content?.trim()) return;
    void saveArticleFromForm(form, { notice: "Draft autosaved." });
  }, AUTOSAVE_INTERVAL_MS);
}

function saveCurrentArticle() {
  const state = controller.getState();
  if (!state.authorized || state.busy) return;
  const form = root.querySelector("[data-form='article']");
  if (!form || !form.reportValidity()) return;
  void saveArticleFromForm(form);
}

function saveArticleFromForm(form, { publish = false, notice } = {}) {
  const input = Object.fromEntries(new FormData(form).entries());
  return controller.saveArticle(input, {
    publish: publish || controller.getState().selectedArticle?.status === ARTICLE_STATUSES.PUBLISHED,
    notice
  });
}

function captureDraftBeforeRender() {
  const form = root.querySelector("[data-form='article']");
  if (!form || !draftSession.dirty) return;
  preservedDraft = {
    articleId: draftSession.articleId,
    values: Object.fromEntries(new FormData(form).entries())
  };
}

function serializeForm(form) {
  return JSON.stringify(Object.fromEntries(new FormData(form).entries()));
}

function restoreFormValues(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (field) field.value = value;
  }
}

function updateLivePreview(form) {
  const body = root.querySelector(".preview-body");
  if (body) body.innerHTML = renderAuthorMarkdown(form.elements.namedItem("content")?.value || "");
  const heading = root.querySelector(".private-preview article h2");
  if (heading) heading.textContent = form.elements.namedItem("title")?.value || "Untitled entry";
}

function openPublishConfirm(form) {
  if (publishConfirmOpen) return;
  const state = controller.getState();
  if (!state.authorized || state.busy) return;
  publishConfirmOpen = true;
  const title = form.elements.namedItem("title")?.value.trim() || "Untitled entry";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title">
      <p class="panel-kicker">Final check</p>
      <h2 id="publish-confirm-title">Publish to reader?</h2>
      <p>"${escapeHtml(title)}" becomes visible in the public reader. You can return it to the private archive later from the publication ledger.</p>
      <div class="modal-actions">
        <button class="quiet-button" type="button" data-modal="cancel">Keep editing</button>
        <button class="publish-button" type="button" data-modal="confirm">Publish now</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => {
    publishConfirmOpen = false;
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector("[data-modal='cancel']").addEventListener("click", close);
  overlay.querySelector("[data-modal='confirm']").addEventListener("click", () => {
    close();
    const liveForm = root.querySelector("[data-form='article']");
    if (liveForm) void saveArticleFromForm(liveForm, { publish: true });
  });
  document.addEventListener("keydown", onKeydown);
  overlay.querySelector("[data-modal='confirm']").focus();
}

function accessNote(state) {
  if (state.authorized) {
    return `Publishing as @${escapeHtml(state.session?.login || "author")}. Drafts remain private until you explicitly publish.`;
  }
  if (state.session) {
    return `${escapeHtml(state.session.login)} is signed in, but is not on the private author allowlist.`;
  }
  return "Authorize with an allowlisted GitHub account to access the private article archive.";
}

function notification(kind, message) {
  return `<div class="notification ${kind}" role="${kind === "error" ? "alert" : "status"}">${escapeHtml(message)}</div>`;
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function formatDate(value) {
  if (!value) {
    return "Not saved";
  }
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function readOrigin(name, fallback) {
  return document.querySelector(`meta[name='${name}']`)?.content || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function toLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function prepareArtworkUpload(file) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 15 * 1024 * 1024) throw new Error("Keep artwork files under 15 MB.");
  const bitmap = await createImageBitmap(file);
  const display = canvasBlob(bitmap, 1800, "image/webp", 0.88);
  const thumb = canvasBlob(bitmap, 640, "image/webp", 0.84);
  const formData = new FormData();
  formData.append("original", file, file.name);
  formData.append("display", await display, `${file.name}.display.webp`);
  formData.append("thumb", await thumb, `${file.name}.thumb.webp`);
  formData.append("altText", file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
  formData.append("width", String(bitmap.width));
  formData.append("height", String(bitmap.height));
  bitmap.close?.();
  return formData;
}

function canvasBlob(bitmap, maxSize, type, quality) {
  const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser could not create a safe image derivative.")), type, quality));
}
