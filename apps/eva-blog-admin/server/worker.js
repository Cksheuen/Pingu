import { createMemoryStorage } from "../src/services/storage.js";
import { createLocalBlogApi } from "../src/services/localBlogApi.js";
import { createSignedDaemonToken, getDaemonSessionFromRequest, getSessionFromRequest } from "../src/services/sessionCookie.js";
import { createGitHubOAuth } from "./auth.js";
import { createD1BlogApi } from "./d1BlogApi.js";
import { jsonResponse, readJson } from "../api/contracts.js";

export function createWorker({
  seedData = { articles: [], comments: [], statuses: [] },
  storage = createMemoryStorage(seedData),
  summaryProvider,
  env = {},
  sessionResolver,
  authorLogins = parseLogins(env.AUTHOR_GITHUB_LOGINS),
  api: apiOverride,
  oauth = createGitHubOAuth({ env })
} = {}) {
  const api = apiOverride || (env.BLOG_DB ? createD1BlogApi({ db: env.BLOG_DB, seedData, summaryProvider }) : createLocalBlogApi({ storage, seedData, summaryProvider }));
  const resolveSession = sessionResolver || ((request) => getSessionFromRequest(request, env.SESSION_SECRET));

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request, env);
      const route = matchRoute(request.method, url.pathname);

      try {
        if (route.name === "listArticles") {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          return withCors(jsonResponse((await api.getSnapshot()).articles), request, env);
        }
        if (route.name === "getArticle") {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          const article = await api.getArticleBySlug(route.params.slug);
          return withCors(article ? jsonResponse(article) : jsonResponse({ error: "Article not found." }, { status: 404 }), request, env);
        }
        if (route.name === "listComments") {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          return withCors(jsonResponse(await api.getCommentsForArticle(route.params.id)), request, env);
        }
        if (route.name === "listArtworks") {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          return withCors(jsonResponse((await api.getSnapshot()).artworks), request, env);
        }
        if (route.name === "getArtwork") {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          const artwork = await api.getArtworkBySlug(route.params.slug);
          return withCors(artwork ? jsonResponse(artwork) : jsonResponse({ error: "Artwork not found." }, { status: 404 }), request, env);
        }
        if (["listRevisions", "checkArticle"].includes(route.name)) {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          if (route.name === "listRevisions") return withCors(jsonResponse(await api.getArticleRevisions(route.params.id)), request, env);
          const article = (await api.getSnapshot()).articles.find((item) => item.id === route.params.id);
          if (!article) return withCors(jsonResponse({ error: "Article not found." }, { status: 404 }), request, env);
          const { inspectPublication } = await import("../src/domain/blog.js");
          return withCors(jsonResponse(inspectPublication(article)), request, env);
        }
        if (route.name === "getStatus") return withCors(jsonResponse((await api.getSnapshot()).publicStatuses), request, env);
        if (route.name === "uploadMedia") {
          const authError = requireAuthor(await resolveSession(request), authorLogins);
          if (authError) return withCors(authError, request, env);
          return withCors(jsonResponse(await uploadArtworkMedia(request, env), { status: 201 }), request, env);
        }
        if (route.name === "getSession") {
          const session = await resolveSession(request);
          return withCors(jsonResponse({ authenticated: Boolean(session), author: Boolean(session && isAuthor(session, authorLogins)), user: session ? publicSession(session) : null }), request, env);
        }
        if (route.name === "createComment") {
          const session = await resolveSession(request);
          if (!session) return withCors(unauthorized(), request, env);
          const body = await readJson(request);
          return withCors(jsonResponse(await api.addComment(route.params.id, body.body, session), { status: 201 }), request, env);
        }
        if (["saveArticle", "publishArticle", "unpublishArticle", "restoreRevision", "saveArtwork", "publishArtwork", "unpublishArtwork", "updateStatus", "updateAutoStatus", "summarizeActivity", "issueDaemonToken"].includes(route.name)) {
          const daemonSession = route.name === "updateAutoStatus" ? await getDaemonSessionFromRequest(request, env.SESSION_SECRET) : null;
          const session = daemonSession || await resolveSession(request);
          if (route.name === "issueDaemonToken") {
            const authError = requireAuthor(session, authorLogins);
            if (authError) return withCors(authError, request, env);
            const issued = await createSignedDaemonToken(session, env.SESSION_SECRET, { ttlSeconds: env.STATUS_DAEMON_TTL_SECONDS });
            return withCors(jsonResponse({ ...issued, scope: "status:auto", session: publicSession(session) }), request, env);
          }
          const authError = requireAuthor(session, authorLogins);
          if (authError) return withCors(authError, request, env);
          if (route.name === "saveArticle") return withCors(jsonResponse(await api.saveArticle(await readJson(request)), { status: 201 }), request, env);
          if (route.name === "publishArticle") return withCors(jsonResponse(await api.publish(route.params.id)), request, env);
          if (route.name === "unpublishArticle") return withCors(jsonResponse(await api.unpublish(route.params.id)), request, env);
          if (route.name === "restoreRevision") {
            const body = await readJson(request);
            return withCors(jsonResponse(await api.restoreArticleRevision(route.params.id, body.revisionId)), request, env);
          }
          if (route.name === "saveArtwork") return withCors(jsonResponse(await api.saveArtwork(await readJson(request)), { status: 201 }), request, env);
          if (route.name === "publishArtwork") return withCors(jsonResponse(await api.publishArtwork(route.params.id)), request, env);
          if (route.name === "unpublishArtwork") return withCors(jsonResponse(await api.unpublishArtwork(route.params.id)), request, env);
          if (route.name === "updateStatus") return withCors(jsonResponse(await api.updateStatus(await readJson(request), session), { status: 201 }), request, env);
          if (route.name === "updateAutoStatus") return withCors(jsonResponse(await api.updateStatus(await readJson(request), session, { safeAuto: true }), { status: 201 }), request, env);
          return withCors(jsonResponse(await api.getRecentActivitySummary()), request, env);
        }
        if (route.name === "githubStart") return withCors(await oauth.start(request), request, env);
        if (route.name === "githubCallback") return withCors(await oauth.callback(request), request, env);
        if (route.name === "logout") return withCors(oauth.logout(request), request, env);
        return withCors(jsonResponse({ error: "Not found." }, { status: 404 }), request, env);
      } catch (error) {
        return withCors(jsonResponse({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }), request, env);
      }
    }
  };
}

let runtimeWorker;

export default {
  async fetch(request, env) {
    if (!runtimeWorker) {
      const seedData = env?.SEED_DATA ? JSON.parse(env.SEED_DATA) : { articles: [], comments: [], statuses: [] };
      runtimeWorker = createWorker({ seedData, env });
    }
    return runtimeWorker.fetch(request);
  }
};

function matchRoute(method, pathname) {
  const routes = [
    ["GET", /^\/api\/articles$/, "listArticles"],
    ["GET", /^\/api\/articles\/([^/]+)$/, "getArticle", ["slug"]],
    ["POST", /^\/api\/articles$/, "saveArticle"],
    ["POST", /^\/api\/articles\/([^/]+)\/publish$/, "publishArticle", ["id"]],
    ["POST", /^\/api\/articles\/([^/]+)\/unpublish$/, "unpublishArticle", ["id"]],
    ["GET", /^\/api\/articles\/([^/]+)\/revisions$/, "listRevisions", ["id"]],
    ["POST", /^\/api\/articles\/([^/]+)\/restore$/, "restoreRevision", ["id"]],
    ["GET", /^\/api\/articles\/([^/]+)\/check$/, "checkArticle", ["id"]],
    ["GET", /^\/api\/artworks$/, "listArtworks"],
    ["GET", /^\/api\/artworks\/([^/]+)$/, "getArtwork", ["slug"]],
    ["POST", /^\/api\/artworks$/, "saveArtwork"],
    ["POST", /^\/api\/artworks\/([^/]+)\/publish$/, "publishArtwork", ["id"]],
    ["POST", /^\/api\/artworks\/([^/]+)\/unpublish$/, "unpublishArtwork", ["id"]],
    ["POST", /^\/api\/media\/upload$/, "uploadMedia"],
    ["GET", /^\/api\/articles\/([^/]+)\/comments$/, "listComments", ["id"]],
    ["POST", /^\/api\/articles\/([^/]+)\/comments$/, "createComment", ["id"]],
    ["GET", /^\/api\/status$/, "getStatus"],
    ["POST", /^\/api\/status$/, "updateStatus"],
    ["POST", /^\/api\/status\/auto$/, "updateAutoStatus"],
    ["POST", /^\/api\/status\/daemon-token$/, "issueDaemonToken"],
    ["POST", /^\/api\/summaries\/activity$/, "summarizeActivity"],
    ["GET", /^\/api\/session$/, "getSession"],
    ["GET", /^\/api\/auth\/github\/start$/, "githubStart"],
    ["GET", /^\/api\/auth\/github\/callback$/, "githubCallback"],
    ["POST", /^\/api\/logout$/, "logout"]
  ];
  for (const [routeMethod, pattern, name, keys = []] of routes) {
    const match = pathname.match(pattern);
    if (method === routeMethod && match) return { name, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) };
  }
  return { name: "notFound", params: {} };
}

function parseLogins(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function isAuthor(session, allowedLogins) {
  return Boolean(session?.login && allowedLogins.includes(String(session.login).toLowerCase()));
}

function requireAuthor(session, allowedLogins) {
  if (!session) return unauthorized();
  if (!isAuthor(session, allowedLogins)) return jsonResponse({ error: "This GitHub user is not allowed to publish Eva Blog content." }, { status: 403 });
  return null;
}

function publicSession(session) {
  return { provider: session.provider, id: session.id, login: session.login, name: session.name || session.login, avatarUrl: session.avatarUrl || "", issuedAt: session.issuedAt };
}

function unauthorized() {
  return jsonResponse({ error: "A signed-in GitHub author is required." }, { status: 401, headers: { "WWW-Authenticate": "GitHub" } });
}

async function uploadArtworkMedia(request, env) {
  if (!env.ARTWORK_BUCKET || typeof env.ARTWORK_BUCKET.put !== "function") {
    throw new Error("Artwork R2 storage is not configured on this author host.");
  }
  const form = await request.formData();
  const original = form.get("original");
  const display = form.get("display");
  const thumb = form.get("thumb");
  if (!(original instanceof File) || !(display instanceof File) || !(thumb instanceof File)) {
    throw new Error("Artwork upload requires original, display, and thumb derivatives.");
  }
  for (const file of [original, display, thumb]) {
    if (!String(file.type || "").startsWith("image/")) throw new Error("Artwork derivatives must be images.");
    if (file.size > 15 * 1024 * 1024) throw new Error("Artwork uploads must be smaller than 15 MB.");
  }
  const prefix = `artworks/${crypto.randomUUID()}`;
  const originalKey = `${prefix}/original/${safeObjectName(original.name)}`;
  const displayKey = `${prefix}/display.webp`;
  const thumbKey = `${prefix}/thumb.webp`;
  await Promise.all([
    env.ARTWORK_BUCKET.put(originalKey, original.stream(), { httpMetadata: { contentType: original.type } }),
    env.ARTWORK_BUCKET.put(displayKey, display.stream(), { httpMetadata: { contentType: "image/webp" } }),
    env.ARTWORK_BUCKET.put(thumbKey, thumb.stream(), { httpMetadata: { contentType: "image/webp" } })
  ]);
  const width = Number(form.get("width"));
  const height = Number(form.get("height"));
  return {
    id: `asset_${crypto.randomUUID()}`,
    originalKey,
    displayKey,
    thumbKey,
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
    altText: String(form.get("altText") || "").trim(),
    mimeType: "image/webp",
    kind: "image"
  };
}

function safeObjectName(value) {
  return String(value || "artwork").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "artwork";
}

function withCors(response, request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const requestOrigin = new URL(request.url).origin;
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (origin !== requestOrigin && !allowed.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
