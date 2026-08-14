import { createMemoryStorage } from "../src/services/storage.js";
import { createPublicBlogApi } from "../src/services/publicBlogApi.js";
import { getSessionFromRequest } from "../src/services/sessionCookie.js";
import { createGitHubOAuth } from "./auth.js";
import { createD1PublicBlogApi } from "../src/services/d1BlogApi.js";
import { jsonResponse, readJson } from "../api/contracts.js";

export function createWorker({
  seedData = { articles: [], comments: [], statuses: [] },
  storage = createMemoryStorage(seedData),
  env = {},
  sessionResolver,
  api: apiOverride,
  oauth = createGitHubOAuth({ env })
} = {}) {
  const api = apiOverride || (env.BLOG_DB ? createD1PublicBlogApi({ db: env.BLOG_DB, seedData }) : createPublicBlogApi({ storage, seedData }));
  const resolveSession = sessionResolver || ((request) => getSessionFromRequest(request, env.SESSION_SECRET));

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && ["/feed.xml", "/sitemap.xml", "/robots.txt"].includes(url.pathname)) {
        return withCors(await distributionResponse(url.pathname, api, env), request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/media/artworks/")) {
        const media = url.pathname.match(/^\/media\/artworks\/([^/]+)\/([^/]+)$/);
        if (media && env.ARTWORK_BUCKET) {
          const asset = await api.getPublishedArtworkAsset(decodeURIComponent(media[1]), decodeURIComponent(media[2]), url.searchParams.get("variant") || "display");
          if (asset?.key) {
            const object = await env.ARTWORK_BUCKET.get(asset.key);
            if (object) return new Response(object.body, { headers: { "Content-Type": asset.mimeType, "Cache-Control": "public, max-age=31536000, immutable" } });
          }
        }
        return new Response("Not found", { status: 404 });
      }
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request, env);
      }
      const route = matchRoute(request.method, url.pathname);

      try {
        if (route.name === "listArticles") {
          return withCors(jsonResponse((await api.getSnapshot()).publishedArticles), request, env);
        }
        if (route.name === "getArticle") {
          const article = await api.getArticleReaderPayload(route.params.slug);
          return withCors(article ? jsonResponse(article) : jsonResponse({ error: "Article not found." }, { status: 404 }), request, env);
        }
        if (route.name === "listArchives") return withCors(jsonResponse((await api.getSnapshot()).archives), request, env);
        if (route.name === "listTags") return withCors(jsonResponse((await api.getSnapshot()).tags), request, env);
        if (route.name === "listSeries") return withCors(jsonResponse((await api.getSnapshot()).series), request, env);
        if (route.name === "listArtworks") return withCors(jsonResponse(await api.getPublishedArtworks()), request, env);
        if (route.name === "getArtwork") {
          const artwork = await api.getPublishedArtworkBySlug(route.params.slug);
          return withCors(artwork ? jsonResponse(artwork) : jsonResponse({ error: "Artwork not found." }, { status: 404 }), request, env);
        }
        if (route.name === "listComments") {
          return withCors(jsonResponse(await api.getCommentsForArticle(route.params.id)), request, env);
        }
        if (route.name === "createComment") {
          const session = await resolveSession(request);
          if (!session) return withCors(unauthorized(), request, env);
          const body = await readJson(request);
          return withCors(jsonResponse(await api.addComment(route.params.id, body.body, session), { status: 201 }), request, env);
        }
        if (route.name === "getStatus") {
          return withCors(jsonResponse((await api.getSnapshot()).publicStatuses), request, env);
        }
        if (route.name === "githubStart") {
          return withCors(await oauth.start(request), request, env);
        }
        if (route.name === "githubCallback") {
          return withCors(await oauth.callback(request), request, env);
        }
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
    ["GET", /^\/api\/archives$/, "listArchives"],
    ["GET", /^\/api\/tags$/, "listTags"],
    ["GET", /^\/api\/series$/, "listSeries"],
    ["GET", /^\/api\/artworks$/, "listArtworks"],
    ["GET", /^\/api\/artworks\/([^/]+)$/, "getArtwork", ["slug"]],
    ["GET", /^\/api\/articles\/([^/]+)\/comments$/, "listComments", ["id"]],
    ["POST", /^\/api\/articles\/([^/]+)\/comments$/, "createComment", ["id"]],
    ["GET", /^\/api\/status$/, "getStatus"],
    ["GET", /^\/api\/auth\/github\/start$/, "githubStart"],
    ["GET", /^\/api\/auth\/github\/callback$/, "githubCallback"]
  ];

  for (const [routeMethod, pattern, name, keys = []] of routes) {
    const match = pathname.match(pattern);
    if (method === routeMethod && match) {
      return { name, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) };
    }
  }
  return { name: "notFound", params: {} };
}

function unauthorized() {
  return jsonResponse({ error: "A signed-in GitHub user is required." }, { status: 401, headers: { "WWW-Authenticate": "GitHub" } });
}

async function distributionResponse(pathname, api, env = {}) {
  const snapshot = await api.getSnapshot();
  if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const base = String(env.PUBLIC_SITE_ORIGIN || "https://eva-blog.example").replace(/\/$/, "");
  if (pathname === "/sitemap.xml") {
    const urls = ["/", "/archive", "/now", "/gallery", ...snapshot.publishedArticles.map((article) => `/article/${article.slug}`), ...snapshot.publishedArtworks.map((artwork) => `/gallery/${artwork.slug}`)];
    return new Response(xmlDocument(urls.map((path) => `<url><loc>${xmlEscape(base + path)}</loc></url>`).join("")), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
  }
  const entries = [...snapshot.publishedArticles.map((article) => rssItem(article.title, `${base}/article/${article.slug}`, article.publishedAt || article.updatedAt, article.excerpt)), ...snapshot.publishedArtworks.map((artwork) => rssItem(artwork.title, `${base}/gallery/${artwork.slug}`, artwork.publishedAt, artwork.caption || artwork.artistNote))];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Eva Blog</title><link>${xmlEscape(base)}</link><description>Field notes, public signals, and visual studies.</description>${entries.join("")}</channel></rss>`, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}

function xmlDocument(entries) { return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`; }
function rssItem(title, link, date, description) { return `<item><title>${xmlEscape(title)}</title><link>${xmlEscape(link)}</link><guid isPermaLink="true">${xmlEscape(link)}</guid><pubDate>${xmlEscape(new Date(date).toUTCString())}</pubDate><description>${xmlEscape(description)}</description></item>`; }
function xmlEscape(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

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
