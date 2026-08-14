import { matchesArticleQuery } from "./domain/publicBlog.js";
import { createLocale, describeLocalizedStatus } from "./services/locale.js";

const locale = createLocale();
const t = (key, values) => locale.t(key, values);
const state = {
  articles: [],
  artworks: [],
  archives: [],
  tags: [],
  series: [],
  publicStatuses: [],
  search: "",
  error: "",
  loading: true,
  selectedSlug: null,
  introCondensed: false,
  routeName: null,
  commentsByArticle: new Map(),
  commentsLoading: new Set()
};

let searchDebounce = null;
let readingFrame = null;

const root = document.querySelector("#app");
window.addEventListener("hashchange", () => {
  window.clearTimeout(searchDebounce);
  state.selectedSlug = parseArticleSlugFromLocation();
  state.introCondensed = false;
  render();
  syncIntroDock();
  const article = selectedArticle();
  if (article) loadComments(article.id);
});
window.addEventListener("scroll", () => {
  syncIntroDock();
  scheduleReadingUi();
}, { passive: true });

state.selectedSlug = parseArticleSlugFromLocation();
render();
await refreshPublicData();

async function refreshPublicData() {
  state.loading = true;
  render();
  try {
    const [articles, publicStatuses, archives, tags, series, artworks] = await Promise.all([
      requestJson("/api/articles"),
      requestJson("/api/status"),
      requestJson("/api/archives"),
      requestJson("/api/tags"),
      requestJson("/api/series"),
      requestJson("/api/artworks")
    ]);
    state.articles = Array.isArray(articles) ? articles : [];
    state.publicStatuses = Array.isArray(publicStatuses) ? publicStatuses : [];
    state.archives = Array.isArray(archives) ? archives : [];
    state.tags = Array.isArray(tags) ? tags : [];
    state.series = Array.isArray(series) ? series : [];
    state.artworks = Array.isArray(artworks) ? artworks : [];
    state.loading = false;
    state.error = "";
    render();
    syncIntroDock();
    const article = selectedArticle();
    if (article) await loadComments(article.id);
  } catch (error) {
    state.loading = false;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function loadComments(articleId) {
  if (state.commentsByArticle.has(articleId) || state.commentsLoading.has(articleId)) return;
  state.commentsLoading.add(articleId);
  render();
  try {
    const comments = await requestJson(`/api/articles/${encodeURIComponent(articleId)}/comments`);
    state.commentsByArticle.set(articleId, Array.isArray(comments) ? comments : []);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.commentsLoading.delete(articleId);
    render();
  }
}

function render() {
  const route = currentRoute();
  const routeChanged = state.routeName !== route.name;
  state.routeName = route.name;
  root.classList.toggle("intro-condensed", route.name === "home" && state.introCondensed);
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/" aria-label="${escapeAttr(t("brand.home"))}">
        <img class="brand-mark" src="/public/assets/blog-cover.png" alt="">
        <span><strong>Eva Blog</strong><small>${escapeHtml(t("brand.tagline"))}</small></span>
      </a>
      <nav class="public-nav" aria-label="${escapeAttr(t("nav.label"))}">
        ${navLink("/", "nav.reader")}
        ${navLink("/archive", "nav.archive")}
        ${navLink("/now", "nav.now")}
        ${navLink("/gallery", "nav.gallery")}
      </nav>
      <div class="topbar-tools"><div class="public-label"><span class="signal-dot"></span>${escapeHtml(t("public.readOnly"))}</div>${localeSwitcher()}</div>
    </header>
    ${route.name === "home" ? introDock() : ""}
    ${state.error ? `<div class="banner error" role="alert">${escapeHtml(state.error)}</div>` : ""}
    <main class="page-main page-public">${route.name === "article" ? articleView(selectedArticle()) : route.name === "archive" ? archiveView() : route.name === "now" ? nowView() : route.name === "gallery" ? galleryView(route.artworkSlug) : homeView()}</main>
    <footer class="app-footer"><span>${escapeHtml(t("footer.reader"))}</span><span>${escapeHtml(t("footer.scope"))}</span></footer>
  `;
  syncSeo(route, route.name === "article" ? selectedArticle() : route.name === "gallery" && route.artworkSlug ? state.artworks.find((artwork) => artwork.slug === route.artworkSlug) : null);
  bindActions();
  if (routeChanged) {
    root.querySelectorAll(".page-main > section, .page-main > article").forEach((section) => section.classList.add("route-enter"));
  }
  syncReadingUi();
}

function localeSwitcher() {
  return `<div class="locale-switch" role="group" aria-label="${escapeAttr(t("locale.label"))}"><button type="button" data-locale="zh" lang="zh" aria-pressed="${locale.language === "zh"}">${escapeHtml(t("locale.zh"))}</button><button type="button" data-locale="en" lang="en" aria-pressed="${locale.language === "en"}">${escapeHtml(t("locale.en"))}</button></div>`;
}

function introDock() {
  return `<div class="home-intro-dock" aria-hidden="${state.introCondensed ? "false" : "true"}"><button type="button" data-action="expand-intro" tabindex="${state.introCondensed ? "0" : "-1"}"><span>${escapeHtml(t("dock.label"))}</span><strong>${plainText(t("home.title"))}</strong><small>${escapeHtml(t("dock.expand"))} ↑</small></button></div>`;
}

function homeView() {
  const article = state.articles[0];
  const artwork = state.artworks[0];
  return `
    <section class="home-hero">
      <div class="hero-copy">
        <p class="eyebrow">${escapeHtml(t("home.kicker"))}</p>
        <h1>${t("home.title")}</h1>
        <p class="hero-intro">${escapeHtml(t("home.intro"))}</p>
        <div class="hero-actions"><a class="primary-link" href="${article ? `#/article/${encodeURIComponent(article.slug)}` : "#/archive"}">${escapeHtml(t(article ? "home.latest" : "home.archive"))} <span>↗</span></a><a class="text-link" href="#/gallery">${escapeHtml(t("home.gallery"))}</a></div>
      </div>
      <div class="hero-figure" aria-label="${escapeAttr(t("home.plate"))}">
        ${artwork ? artworkImage(artwork, "hero-artwork") : `<img src="/public/assets/blog-cover.png" alt="" class="hero-artwork" loading="lazy">`}
        <div class="figure-caption"><span>${escapeHtml(t("home.plate"))}</span><strong>${escapeHtml(artwork?.title || t("home.fallbackArtwork"))}</strong></div>
      </div>
    </section>
    <section class="home-ledger">
      <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t("home.recent"))}</p><h2>${escapeHtml(t("home.start"))}</h2></div><a class="text-link" href="#/archive">${escapeHtml(t("home.viewArchive"))}</a></div>
      <div class="home-article-grid">${state.loading ? emptyState(t("home.opening")) : state.articles.slice(0, 3).map((item, index) => articleCard(item, index === 0 ? "featured" : "")).join("") || emptyState(t("home.empty"))}</div>
    </section>
    <section class="signal-ribbon"><div><p class="eyebrow">${escapeHtml(t("nav.now"))}</p><strong>${escapeHtml(describeLocalizedStatus(state.publicStatuses[0], locale))}</strong></div><a href="#/now">${escapeHtml(t("home.follow"))}</a></section>
  `;
}

function archiveView() {
  const filtered = state.articles.filter((article) => matchesArticleQuery(article, state.search));
  return `<section class="archive-view"><div class="archive-intro"><div><p class="eyebrow">${escapeHtml(t("archive.kicker", { count: String(state.articles.length).padStart(2, "0") }))}</p><h1>${t("archive.title")}</h1></div><p>${escapeHtml(t("archive.intro"))}</p></div>
    <label class="archive-search"><span>${escapeHtml(t("archive.search"))}</span><input data-field="search" value="${escapeAttr(state.search)}" placeholder="${escapeAttr(t("archive.placeholder"))}"></label>
    <div class="archive-layout"><div class="archive-stream">${filtered.length ? filtered.map((article, index) => articleCard(article, index === 0 ? "archive-feature" : "")).join("") : emptyState(t("archive.empty"))}</div><aside class="archive-index"><p class="eyebrow">${escapeHtml(t("archive.index"))}</p><h2>${escapeHtml(t("archive.year"))}</h2>${state.archives.map((group) => `<div class="index-year"><strong>${escapeHtml(group.year)}</strong><span>${escapeHtml(t("archive.notes", { count: group.entries.length }))}</span></div>`).join("")}<h2 class="index-subhead">${escapeHtml(t("archive.tag"))}</h2><div class="tag-cloud">${state.tags.slice(0, 12).map((tag) => `<button type="button" data-tag="${escapeAttr(tag.tag)}">${escapeHtml(tag.tag)} <small>${tag.count}</small></button>`).join("")}</div>${state.series.length ? `<h2 class="index-subhead">${escapeHtml(t("archive.series"))}</h2>${state.series.map((series) => `<div class="series-index"><strong>${escapeHtml(series.title)}</strong><span>${escapeHtml(t("archive.parts", { count: series.entries.length }))}</span></div>`).join("")}` : ""}</aside></div></section>`;
}

function nowView() {
  return `<section class="now-view"><div class="now-intro"><p class="eyebrow">${escapeHtml(t("now.kicker"))}</p><h1>${t("now.title")}</h1><p>${escapeHtml(t("now.intro"))}</p></div><div class="now-timeline">${state.publicStatuses.length ? state.publicStatuses.map((status, index) => `<article class="now-entry"><span class="now-index">${String(index + 1).padStart(2, "0")}</span><div class="now-entry-main"><div class="now-entry-meta"><span>${escapeHtml(localizedKind(status.kind))}</span><time>${formatDate(status.updatedAt || status.createdAt)}</time></div><h2>${escapeHtml(status.title || describeLocalizedStatus(status, locale))}</h2><p>${escapeHtml(status.details || describeLocalizedStatus(status, locale))}</p>${status.meta ? `<div class="signal-meta">${Object.entries(status.meta).filter(([key]) => ["track", "artist", "service", "usagePercent", "unit"].includes(key)).map(([key, value]) => `<span>${escapeHtml(t(`status.meta.${key}`))}: ${escapeHtml(value)}</span>`).join("")}</div>` : ""}</div></article>`).join("") : emptyState(t("now.empty"))}</div></section>`;
}

function galleryView(artworkSlug = null) {
  if (artworkSlug) {
    const artwork = state.artworks.find((item) => item.slug === artworkSlug);
    if (!artwork) return emptyState(state.loading ? t("gallery.opening") : t("gallery.unavailable"));
    return `<section class="artwork-detail"><a class="reader-crumb" href="#/gallery">${escapeHtml(t("gallery.back"))}</a><div class="artwork-detail-grid">${artworkImage(artwork, "artwork-detail-image")}<div class="artwork-detail-copy"><p class="eyebrow">${escapeHtml(artwork.medium || t("gallery.visualStudy"))} / ${formatDate(artwork.publishedAt)}</p><h1>${escapeHtml(artwork.title)}</h1><p class="artwork-caption">${escapeHtml(artwork.caption || "")}</p><div class="artist-note"><span class="eyebrow">${escapeHtml(t("gallery.artistNote"))}</span><p>${escapeHtml(artwork.artistNote || t("gallery.fallbackNote"))}</p></div><div class="card-footer"><span>${escapeHtml(artwork.license || t("gallery.rights"))}</span>${artwork.relatedArticleSlug ? `<a href="#/article/${encodeURIComponent(artwork.relatedArticleSlug)}">${escapeHtml(t("gallery.related"))}</a>` : ""}</div></div></div></section>`;
  }
  return `<section class="gallery-view"><div class="gallery-intro"><div><p class="eyebrow">${escapeHtml(t("gallery.kicker"))}</p><h1>${t("gallery.title")}</h1></div><p>${escapeHtml(t("gallery.intro"))}</p></div><div class="gallery-grid">${state.artworks.length ? state.artworks.map((artwork, index) => artworkCard(artwork, index === 0 ? "gallery-feature" : "")).join("") : emptyState(t("gallery.empty"))}</div></section>`;
}

function articleView(article) {
  if (!article) return emptyState(state.loading ? t("reader.loading") : t("reader.unavailable"));
  const comments = state.commentsByArticle.get(article.id) || [];
  const commentsPending = state.commentsLoading.has(article.id);
  const outline = article.outline || outlineFromContent(article.content);
  const summary = article.summary?.text || t("reader.summaryPending");
  return `<div class="reading-progress" aria-hidden="true"><span></span></div><article class="long-reader"><div class="reader-progress" aria-hidden="true"><span style="width:${Math.min(100, Math.max(8, (article.readingMinutes || 1) * 13))}%"></span></div><div class="reader-crumb"><a href="#/archive">${escapeHtml(t("reader.archive"))}</a><span>/</span><span>${escapeHtml(article.series?.title || t("reader.fieldNotes"))}</span></div><header class="article-heading"><p class="eyebrow">${formatDate(article.publishedAt || article.updatedAt)} · ${escapeHtml(t("reader.minRead", { count: article.readingMinutes || 1 }))}</p><h1>${escapeHtml(article.title)}</h1><p class="article-deck">${escapeHtml(article.excerpt)}</p><div class="tag-row">${(article.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div></header><div class="reader-layout"><aside class="reader-aside">${outline.length ? `<div class="toc"><span class="eyebrow">${escapeHtml(t("reader.onThisPage"))}</span>${outline.map((item) => `<a href="#${escapeAttr(item.id)}" class="depth-${item.depth}">${escapeHtml(item.text)}</a>`).join("")}</div>` : ""}<div class="reader-fact"><span>${escapeHtml(t("reader.digest"))}</span><p>${escapeHtml(summary)}</p><small>${escapeHtml(article.summary?.provider || t("reader.pending"))}</small></div></aside><div class="reader-manuscript"><div class="markdown-body">${renderMarkdown(article.content)}</div><div class="reader-tools"><button type="button" data-action="copy-link">${escapeHtml(t("reader.copy"))}</button><span>${escapeHtml(t("reader.sourceChars", { count: article.content.length.toLocaleString(locale.language === "zh" ? "zh-CN" : "en") }))}</span></div>${relatedArticlesMarkup(article)}</div></div><section class="comments-section"><div class="section-title"><div><p class="eyebrow">${escapeHtml(t("comments.kicker"))}</p><h2>${escapeHtml(t("comments.title"))}</h2></div><span>${comments.length}</span></div><div class="comment-list">${commentsPending ? emptyState(t("comments.loading")) : comments.length ? comments.map(commentMarkup).join("") : emptyState(t("comments.empty"))}</div>${commentForm()}</section></article><button type="button" class="back-to-top" data-action="back-to-top" aria-label="${escapeAttr(t("reader.backToTop"))}">↑</button>`;
}

function articleCard(article, variant = "") {
  return `<article class="article-card ${variant}"><div class="article-card-index">${String(article.publishedAt || article.updatedAt).slice(0, 4)} / ${escapeHtml(t("reader.minRead", { count: article.readingMinutes || 1 }))}</div><h2><a href="#/article/${encodeURIComponent(article.slug)}">${escapeHtml(article.title)}</a></h2><p>${escapeHtml(article.excerpt)}</p><div class="card-footer"><div class="tag-row">${(article.tags || []).slice(0, 3).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div><a href="#/article/${encodeURIComponent(article.slug)}" aria-label="${escapeAttr(`${t("home.latest")}: ${article.title}`)}">↗</a></div></article>`;
}

function artworkCard(artwork, variant = "") {
  return `<article class="gallery-card ${variant}">${artworkImage(artwork, "gallery-card-image")}<div class="gallery-card-copy"><div><p class="eyebrow">${escapeHtml(artwork.medium || t("gallery.visualStudy"))}</p><h2><a href="#/gallery/${encodeURIComponent(artwork.slug)}">${escapeHtml(artwork.title)}</a></h2></div><p>${escapeHtml(artwork.caption || artwork.artistNote || t("gallery.fallbackNote"))}</p><div class="card-footer"><span>${escapeHtml(artwork.dimensions ? `${artwork.dimensions.width} × ${artwork.dimensions.height}` : t("gallery.openStudy"))}</span><span>${formatDate(artwork.publishedAt)}</span></div></div></article>`;
}

function artworkImage(artwork, className) {
  const asset = artwork.assets?.[0];
  return asset ? `<img class="${className}" src="${escapeAttr(asset.src)}" alt="${escapeAttr(asset.altText || artwork.altText || artwork.title)}" loading="lazy">` : `<div class="${className} artwork-placeholder" aria-label="${escapeAttr(artwork.altText || artwork.title)}"><span>${escapeHtml(artwork.title.slice(0, 1))}</span></div>`;
}

function relatedArticlesMarkup(article) {
  const related = article.related || state.articles.filter((candidate) => candidate.id !== article.id && (candidate.tags || []).some((tag) => article.tags?.includes(tag))).slice(0, 3);
  return related.length ? `<section class="related-section"><p class="eyebrow">${escapeHtml(t("reader.continue"))}</p><div>${related.map((item) => `<a href="#/article/${encodeURIComponent(item.slug)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(t("reader.minutes", { count: item.readingMinutes || 1 }))}</span></a>`).join("")}</div></section>` : "";
}

function selectedArticle() {
  return state.selectedSlug ? state.articles.find((article) => article.slug === state.selectedSlug) || null : state.articles[0] || null;
}

function currentRoute() {
  const hash = window.location.hash || "#/";
  if (window.location.pathname.startsWith("/article/")) return { name: "article" };
  if (window.location.pathname.startsWith("/gallery/")) return { name: "gallery", artworkSlug: decodeURIComponent(window.location.pathname.slice("/gallery/".length)) };
  if (hash.startsWith("#/article/")) return { name: "article" };
  if (hash === "#/archive") return { name: "archive" };
  if (hash === "#/now") return { name: "now" };
  if (hash === "#/gallery" || hash.startsWith("#/gallery/")) return { name: "gallery", artworkSlug: hash.startsWith("#/gallery/") ? decodeURIComponent(hash.slice("#/gallery/".length)) : null };
  return { name: "home" };
}

function navLink(path, key) {
  const active = (path === "/" && currentRoute().name === "home") || (path !== "/" && currentRoute().name === path.slice(1)) ? "active" : "";
  return `<a class="${active}" href="#${path}">${escapeHtml(t(key))}</a>`;
}

function syncIntroDock() {
  const isHome = currentRoute().name === "home";
  const shouldCondense = isHome && (state.introCondensed ? window.scrollY > 42 : window.scrollY > 150);
  if (shouldCondense === state.introCondensed) return;
  state.introCondensed = shouldCondense;
  root.classList.toggle("intro-condensed", shouldCondense);
  const dock = root.querySelector(".home-intro-dock");
  if (dock) {
    dock.setAttribute("aria-hidden", String(!shouldCondense));
    dock.querySelector("button")?.setAttribute("tabindex", shouldCondense ? "0" : "-1");
  }
}

function scheduleReadingUi() {
  if (readingFrame !== null) return;
  readingFrame = requestAnimationFrame(() => {
    readingFrame = null;
    syncReadingUi();
  });
}

function syncReadingUi() {
  const article = root.querySelector(".long-reader");
  const bar = root.querySelector(".reading-progress span");
  if (article && bar) {
    const rect = article.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    const progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : rect.top <= 0 ? 1 : 0;
    bar.style.transform = `scaleX(${progress})`;
  }
  const button = root.querySelector(".back-to-top");
  if (button) button.classList.toggle("is-visible", window.scrollY > window.innerHeight);
}

function syncSeo(route, article) {
  const title = article ? `${article.title} — Eva Blog` : route.name === "gallery" ? t("seo.gallery") : route.name === "now" ? t("seo.now") : route.name === "archive" ? t("seo.archive") : t("seo.home");
  document.documentElement.lang = locale.language === "zh" ? "zh-CN" : "en";
  document.title = title;
  const description = article?.seoDescription || article?.excerpt || t("seo.description");
  document.querySelector("meta[name='description']")?.setAttribute("content", description);
  document.querySelector("meta[property='og:title']")?.setAttribute("content", title);
  document.querySelector("meta[property='og:description']")?.setAttribute("content", description);
  const canonicalPath = article ? (article.assets ? `/gallery/${encodeURIComponent(article.slug)}` : `/article/${encodeURIComponent(article.slug)}`) : window.location.pathname;
  document.querySelector("link[rel='canonical']")?.setAttribute("href", `${window.location.origin}${canonicalPath}`);
}

function bindActions() {
  root.querySelector("[data-field='search']")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      render();
      const input = root.querySelector("[data-field='search']");
      if (input) {
        const position = input.value.length;
        input.focus();
        input.setSelectionRange(position, position);
      }
    }, 300);
  });
  root.querySelectorAll("[data-tag]").forEach((button) => button.addEventListener("click", () => {
    window.clearTimeout(searchDebounce);
    state.search = button.dataset.tag;
    render();
  }));
  root.querySelectorAll("[data-locale]").forEach((button) => button.addEventListener("click", () => { locale.setLanguage(button.dataset.locale); render(); }));
  root.querySelector("[data-action='expand-intro']")?.addEventListener("click", () => { state.introCondensed = false; root.classList.remove("intro-condensed"); window.scrollTo({ top: 0, behavior: "smooth" }); });
  root.querySelector("[data-action='back-to-top']")?.addEventListener("click", () => { window.scrollTo({ top: 0, behavior: "smooth" }); });
  root.querySelector("[data-action='copy-link']")?.addEventListener("click", async (event) => { await navigator.clipboard?.writeText(window.location.href); event.currentTarget.textContent = t("reader.copied"); });
  root.querySelector("[data-form='comment']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const article = selectedArticle();
    runAction(async () => {
      const response = await fetch(`/api/articles/${encodeURIComponent(article.id)}/comments`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: new FormData(event.currentTarget).get("body") }) });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.assign(`/api/auth/github/start?redirect=${encodeURIComponent(window.location.href)}`); return; }
      if (!response.ok) throw new Error(payload.error || "Comment could not be posted.");
      state.commentsByArticle.set(article.id, [...(state.commentsByArticle.get(article.id) || []), payload]);
    });
  });
}

function commentForm() { return `<form class="comment-form" data-form="comment"><textarea name="body" rows="4" placeholder="${escapeAttr(t("comments.placeholder"))}" required></textarea><button type="submit">${escapeHtml(t("comments.post"))}</button></form>`; }
function commentMarkup(comment) { return `<article class="comment"><img src="${escapeAttr(comment.author.avatarUrl)}" alt="" loading="lazy"><div><strong>@${escapeHtml(comment.author.login)}</strong><small>${formatDate(comment.createdAt)}</small><p>${escapeHtml(comment.body)}</p></div></article>`; }

function renderMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let codeOpen = false;
  for (const line of lines) {
    if (line.startsWith("```")) { if (listOpen) { html.push("</ul>"); listOpen = false; } html.push(codeOpen ? "</code></pre>" : "<pre><code>"); codeOpen = !codeOpen; continue; }
    if (codeOpen) { html.push(escapeHtml(line) + "\n"); continue; }
    if (!line.trim()) { if (listOpen) { html.push("</ul>"); listOpen = false; } continue; }
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) { html.push(`<figure class="manuscript-image"><img src="${safeUrl(image[2])}" alt="${escapeAttr(image[1])}" loading="lazy"><figcaption>${escapeHtml(image[1])}</figcaption></figure>`); continue; }
    if (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### ")) { if (listOpen) { html.push("</ul>"); listOpen = false; } const depth = line.match(/^#+/)[0].length; const text = line.slice(depth + 1); html.push(`<h${Math.min(3, depth)} id="${escapeAttr(slugify(text))}">${escapeHtml(text)}</h${Math.min(3, depth)}>`); }
    else if (line.startsWith("- ")) { if (!listOpen) { html.push("<ul>"); listOpen = true; } html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`); }
    else { if (listOpen) { html.push("</ul>"); listOpen = false; } html.push(`<p>${inlineMarkdown(line)}</p>`); }
  }
  if (listOpen) html.push("</ul>");
  if (codeOpen) html.push("</code></pre>");
  return html.join("");
}

function localizedKind(kind) { return kind === "song" ? t("status.listening") : kind === "work" ? t("status.working") : kind === "token" ? t("status.token") : t("status.active"); }
function inlineMarkdown(value) { return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>"); }
function outlineFromContent(content) { return String(content || "").split(/\r?\n/).flatMap((line) => { const match = line.match(/^(#{2,3})\s+(.+)$/); return match ? [{ depth: match[1].length, text: match[2], id: slugify(match[2]) }] : []; }); }
function slugify(value) { return String(value || "section").toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "") || "section"; }
function safeUrl(value) { const url = String(value || "").trim(); return /^(https?:\/\/|\/|\.\/)/i.test(url) ? escapeAttr(url) : ""; }
function emptyState(text) { return `<div class="empty-state">${escapeHtml(text)}</div>`; }
function formatDate(value) { return locale.formatDate(value); }
function parseArticleSlugFromLocation() { const pathMatch = window.location.pathname.match(/^\/article\/([^/]+)/); if (pathMatch) return decodeURIComponent(pathMatch[1]); const match = (window.location.hash || "").match(/^#\/article\/([^/]+)/); return match ? decodeURIComponent(match[1]) : null; }
function plainText(value) { return String(value).replace(/<[^>]+>/g, ""); }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#096;"); }
async function requestJson(path) { const response = await fetch(path, { credentials: "include" }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || `Public API returned ${response.status}.`); return payload; }
async function runAction(action) { state.error = ""; try { await action(); } catch (error) { state.error = error instanceof Error ? error.message : String(error); } render(); }
