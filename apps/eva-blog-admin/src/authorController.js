import { ARTICLE_STATUSES, parseMarkdownArticle } from "./domain/blog.js";

const INITIAL_STATE = Object.freeze({
  articles: [],
  artworks: [],
  authorized: false,
  busy: false,
  editingId: null,
  error: "",
  loading: true,
  notice: "",
  revisions: [],
  quality: null,
  pendingArtworkAsset: null,
  previewMode: false,
  session: null
});

export function createAuthorController({ api, parseMarkdown = parseMarkdownArticle } = {}) {
  if (!api) {
    throw new Error("createAuthorController requires an author API.");
  }

  let state = { ...INITIAL_STATE };
  const listeners = new Set();

  function emit() {
    const snapshot = getState();
    listeners.forEach((listener) => listener(snapshot));
  }

  function setState(next) {
    state = { ...state, ...next };
    emit();
  }

  function getState() {
    const articles = state.articles.map((article) => ({ ...article, tags: [...(article.tags || [])] }));
    const selectedArticle = state.editingId ? articles.find((article) => article.id === state.editingId) || null : null;

    return {
      ...state,
      articles,
      selectedArticle,
      session: state.session ? { ...state.session } : null
    };
  }

  async function initialize() {
    setState({ loading: true, error: "", notice: "" });
    try {
      const sessionPayload = await api.getSession();
      const session = sessionPayload.user || null;
      const authorized = Boolean(sessionPayload.author);

      if (!authorized) {
        setState({
          articles: [],
          authorized,
          editingId: null,
          session
        });
        return getState();
      }

      const [articlePayload, artworkPayload] = await Promise.all([
        api.listArticles(),
        api.listArtworks ? api.listArtworks() : Promise.resolve([])
      ]);
      const articles = normalizeArticles(articlePayload);
      setState({
        articles,
        artworks: Array.isArray(artworkPayload) ? artworkPayload : [],
        authorized,
        editingId: selectExistingArticle(state.editingId, articles),
        session
      });
    } catch (error) {
      setState({ error: messageFrom(error) });
    } finally {
      setState({ loading: false });
    }

    return getState();
  }

  function selectArticle(id) {
    const editingId = state.articles.some((article) => article.id === id) ? id : null;
    setState({ editingId, error: "", notice: "", revisions: [], quality: null });
    if (editingId && api.listRevisions) {
      api.listRevisions(editingId).then((revisions) => setState({ revisions: Array.isArray(revisions) ? revisions : [] })).catch((error) => setState({ error: messageFrom(error) }));
    }
    if (editingId && api.checkArticle) {
      api.checkArticle(editingId).then((quality) => setState({ quality })).catch((error) => setState({ error: messageFrom(error) }));
    }
  }

  function startNewArticle() {
    if (!state.authorized) {
      return;
    }
    setState({ editingId: null, error: "", notice: "", revisions: [], quality: null, previewMode: false });
  }

  function togglePreview() {
    if (!state.authorized) return;
    setState({ previewMode: !state.previewMode, error: "" });
  }

  async function saveArticle(input, { publish = false, notice } = {}) {
    return perform(async () => {
      requireAuthor();
      const article = await api.saveArticle({ ...input, publish });
      const articles = replaceArticle(state.articles, article);
      setState({
        articles,
        editingId: article.id,
        quality: null,
        notice: notice || (article.status === ARTICLE_STATUSES.PUBLISHED ? "Changes are live in the reader." : "Draft saved to the private archive.")
      });
      return article;
    });
  }

  async function importMarkdown(filename, markdown) {
    const parsed = parseMarkdown(filename, markdown);
    return saveArticle(parsed, { notice: "Markdown imported as a private draft." });
  }

  async function publishArticle(id) {
    return perform(async () => {
      requireAuthor();
      const article = await api.publishArticle(id);
      setState({
        articles: replaceArticle(state.articles, article),
        editingId: article.id,
        notice: "Article published to the reader."
      });
      if (api.checkArticle) setState({ quality: await api.checkArticle(id) });
      return article;
    });
  }

  async function unpublishArticle(id) {
    return perform(async () => {
      requireAuthor();
      const article = await api.unpublishArticle(id);
      setState({ articles: replaceArticle(state.articles, article), editingId: article.id, notice: "Article returned to the private archive." });
      return article;
    });
  }

  async function restoreRevision(articleId, revisionId) {
    return perform(async () => {
      requireAuthor();
      const article = await api.restoreRevision(articleId, revisionId);
      setState({ articles: replaceArticle(state.articles, article), editingId: article.id, notice: "Revision restored as the current private draft." });
      return article;
    });
  }

  async function saveArtwork(input, { publish = false } = {}) {
    return perform(async () => {
      requireAuthor();
      const artwork = await api.saveArtwork({ ...input, publish });
      const artworks = replaceArtwork(state.artworks, artwork);
      setState({ artworks, notice: publish ? "Artwork published to the gallery." : "Artwork saved to the private studio." });
      return artwork;
    });
  }

  async function uploadArtworkAsset(formData) {
    return perform(async () => {
      requireAuthor();
      if (!api.uploadArtworkAsset) throw new Error("Artwork upload is not configured for this author host.");
      const asset = await api.uploadArtworkAsset(formData);
      setState({ pendingArtworkAsset: asset, notice: "Safe display derivatives are ready for the next sketch." });
      return asset;
    });
  }

  async function publishArtwork(id) {
    return perform(async () => {
      requireAuthor();
      const artwork = await api.publishArtwork(id);
      setState({ artworks: replaceArtwork(state.artworks, artwork), notice: "Artwork published to the gallery." });
      return artwork;
    });
  }

  async function unpublishArtwork(id) {
    return perform(async () => {
      requireAuthor();
      const artwork = await api.unpublishArtwork(id);
      setState({ artworks: replaceArtwork(state.artworks, artwork), notice: "Artwork returned to the private studio." });
      return artwork;
    });
  }

  async function logout() {
    return perform(async () => {
      await api.logout();
      setState({
        articles: [],
        artworks: [],
        authorized: false,
        editingId: null,
        notice: "Signed out. Private article data has been cleared from this page.",
        session: null
      });
    });
  }

  async function perform(action) {
    setState({ busy: true, error: "", notice: "" });
    try {
      return await action();
    } catch (error) {
      setState({ error: messageFrom(error) });
      return null;
    } finally {
      setState({ busy: false });
    }
  }

  function requireAuthor() {
    if (!state.authorized) {
      throw new Error("Authorize with an allowlisted GitHub account before editing.");
    }
  }

  return {
    getState,
    importMarkdown,
    initialize,
    logout,
    publishArticle,
    unpublishArticle,
    restoreRevision,
    saveArtwork,
    publishArtwork,
    unpublishArtwork,
    uploadArtworkAsset,
    saveArticle,
    selectArticle,
    startNewArticle,
    togglePreview,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function normalizeArticles(articles) {
  return Array.isArray(articles) ? [...articles].sort(sortByUpdatedAt) : [];
}

function replaceArticle(articles, updatedArticle) {
  const existing = articles.some((article) => article.id === updatedArticle.id);
  return normalizeArticles(existing
    ? articles.map((article) => article.id === updatedArticle.id ? updatedArticle : article)
    : [updatedArticle, ...articles]);
}

function replaceArtwork(artworks, updatedArtwork) {
  const existing = artworks.some((artwork) => artwork.id === updatedArtwork.id);
  return existing
    ? artworks.map((artwork) => artwork.id === updatedArtwork.id ? updatedArtwork : artwork)
    : [updatedArtwork, ...artworks];
}

function selectExistingArticle(currentId, articles) {
  return articles.some((article) => article.id === currentId)
    ? currentId
    : articles[0]?.id || null;
}

function sortByUpdatedAt(left, right) {
  return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
}

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}
