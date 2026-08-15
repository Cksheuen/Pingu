import { createMemoryStorage } from "../src/services/storage";
import { createPublicBlogApi } from "../src/services/publicBlogApi";
import type { PublicBlogApi, BlogSnapshot } from "../src/services/publicBlogApi";
import { getSessionFromRequest } from "../src/services/sessionCookie";
import { createGitHubOAuth } from "./auth";
import type { OAuthEnv } from "./auth";
import { createD1PublicBlogApi } from "../src/services/d1BlogApi";
import type { D1DatabaseLike, D1PublicBlogApi } from "../src/services/d1BlogApi";
import { jsonResponse, readJson } from "../api/contracts";
import type { BlogState, Comment, PublicArticle, PublicArtwork, Session, StorageAdapter } from "../src/types";

// Worker 环境：OAuth 配置 + 数据绑定 + 站点配置。
export interface WorkerEnv extends OAuthEnv {
  BLOG_DB?: D1DatabaseLike;
  ARTWORK_BUCKET?: ArtworkBucketLike;
  PUBLIC_SITE_ORIGIN?: string;
  SEED_DATA?: string;
  ALLOWED_ORIGINS?: string;
}

// R2 绑定的最小结构（仅用到 get(key).body）。
interface ArtworkBucketLike {
  get(key: string): Promise<{ body: BodyInit | null } | null>;
}

// 同步（内存）与异步（D1）两套 API 的联合，调用处统一 await。
type BlogApi = PublicBlogApi | D1PublicBlogApi;

interface GitHubOAuthLike {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
}

export interface CreateWorkerOptions {
  seedData?: BlogState;
  storage?: StorageAdapter;
  env?: WorkerEnv;
  // 允许同步返回（测试注入）或异步返回（默认 cookie 解析）。
  sessionResolver?: (request: Request) => Promise<Session | null> | Session | null;
  api?: BlogApi;
  oauth?: GitHubOAuthLike;
}

const EMPTY_SEED: BlogState = { articles: [], artworks: [], comments: [], statuses: [] };

export function createWorker({
  seedData = EMPTY_SEED,
  storage = createMemoryStorage(seedData),
  env = {},
  sessionResolver,
  api: apiOverride,
  oauth = createGitHubOAuth({ env })
}: CreateWorkerOptions = {}) {
  const api: BlogApi = apiOverride || (env.BLOG_DB ? createD1PublicBlogApi({ db: env.BLOG_DB, seedData }) : createPublicBlogApi({ storage, seedData }));
  const resolveSession = sessionResolver || ((request: Request) => getSessionFromRequest(request, env.SESSION_SECRET));

  return {
    async fetch(request: Request): Promise<Response> {
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
          return withCors(jsonResponse(await api.addComment(route.params.id, String(body.body ?? ""), session), { status: 201 }), request, env);
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

let runtimeWorker: ReturnType<typeof createWorker> | undefined;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!runtimeWorker) {
      const seedData = env?.SEED_DATA ? (JSON.parse(env.SEED_DATA) as BlogState) : EMPTY_SEED;
      runtimeWorker = createWorker({ seedData, env });
    }
    return runtimeWorker.fetch(request);
  }
};

function matchRoute(method: string, pathname: string): { name: string; params: Record<string, string> } {
  const routes: Array<[string, RegExp, string, string[]?]> = [
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
      return { name, params: Object.fromEntries(keys.map((key, index): [string, string] => [key, decodeURIComponent(match[index + 1])])) };
    }
  }
  return { name: "notFound", params: {} };
}

function unauthorized(): Response {
  return jsonResponse({ error: "A signed-in GitHub user is required." }, { status: 401, headers: { "WWW-Authenticate": "GitHub" } });
}

async function distributionResponse(pathname: string, api: { getSnapshot(): BlogSnapshot | Promise<BlogSnapshot> }, env: WorkerEnv = {}): Promise<Response> {
  const snapshot = await api.getSnapshot();
  if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const base = String(env.PUBLIC_SITE_ORIGIN || "https://eva-blog.example").replace(/\/$/, "");
  if (pathname === "/sitemap.xml") {
    const urls = ["/", "/archive", "/now", "/gallery", ...snapshot.publishedArticles.map((article: PublicArticle) => `/article/${article.slug}`), ...snapshot.publishedArtworks.map((artwork: PublicArtwork) => `/gallery/${artwork.slug}`)];
    return new Response(xmlDocument(urls.map((path: string) => `<url><loc>${xmlEscape(base + path)}</loc></url>`).join("")), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
  }
  const entries = [...snapshot.publishedArticles.map((article: PublicArticle) => rssItem(article.title, `${base}/article/${article.slug}`, article.publishedAt || article.updatedAt, article.excerpt)), ...snapshot.publishedArtworks.map((artwork: PublicArtwork) => rssItem(artwork.title, `${base}/gallery/${artwork.slug}`, artwork.publishedAt, artwork.caption || artwork.artistNote))];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Eva Blog</title><link>${xmlEscape(base)}</link><description>Field notes, public signals, and visual studies.</description>${entries.join("")}</channel></rss>`, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}

function xmlDocument(entries: string): string { return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`; }
function rssItem(title: string, link: string, date: string | undefined, description: string | undefined): string { return `<item><title>${xmlEscape(title)}</title><link>${xmlEscape(link)}</link><guid isPermaLink="true">${xmlEscape(link)}</guid><pubDate>${xmlEscape(new Date(date ?? "").toUTCString())}</pubDate><description>${xmlEscape(description ?? "")}</description></item>`; }
function xmlEscape(value: unknown): string { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

function withCors(response: Response, request: Request, env: WorkerEnv): Response {
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
