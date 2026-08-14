export function createAuthorApi({ fetchImpl = globalThis.fetch, baseUrl = "" } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createAuthorApi requires a fetch implementation.");
  }

  return {
    getSession() {
      return request("/api/session");
    },
    listArticles() {
      return request("/api/articles");
    },
    listArtworks() {
      return request("/api/artworks");
    },
    listRevisions(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/revisions`);
    },
    checkArticle(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/check`);
    },
    logout() {
      return request("/api/logout", { method: "POST" });
    },
    publishArticle(id) {
      return request(`/api/articles/${encodeURIComponent(id)}/publish`, { method: "POST" });
    },
    unpublishArticle(id) {
      return request(`/api/articles/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
    },
    restoreRevision(articleId, revisionId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/restore`, { method: "POST", body: { revisionId } });
    },
    saveArticle(input) {
      return request("/api/articles", { method: "POST", body: input });
    },
    saveArtwork(input) {
      return request("/api/artworks", { method: "POST", body: input });
    },
    uploadArtworkAsset(formData) {
      return request("/api/media/upload", { method: "POST", body: formData });
    },
    publishArtwork(id) {
      return request(`/api/artworks/${encodeURIComponent(id)}/publish`, { method: "POST" });
    },
    unpublishArtwork(id) {
      return request(`/api/artworks/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
    }
  };

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const hasBody = options.body !== undefined && options.body !== null;
    const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
    if (hasBody && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      credentials: "include",
      headers,
      body: hasBody && !isFormData && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Author API returned ${response.status}.`);
    }

    return payload;
  }
}
