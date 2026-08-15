import { createMemoryStorage } from "./storage";
import { createPublicBlogApi } from "./publicBlogApi";
import type { PublicBlogApi } from "./publicBlogApi";
import type { BlogState, Session, StorageAdapter } from "../types";

const STATE_ID = "primary";

// Cloudflare D1 绑定的最小结构类型（仅本模块使用到的 prepare/bind/first/run）。
interface D1Row {
  payload?: string;
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = D1Row>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

// D1 版 API 的每个方法都经过 withApi 异步包装。
type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result ? (...args: Args) => Promise<Result> : T[K];
};

export type D1PublicBlogApi = Promisified<PublicBlogApi>;

interface CreateD1ApiOptions {
  db: D1DatabaseLike;
  seedData?: BlogState;
  now?: () => string;
}

export function createD1PublicBlogApi({ db, seedData, now }: CreateD1ApiOptions): D1PublicBlogApi {
  if (!db) throw new Error("createD1PublicBlogApi requires a D1 binding.");

  async function readState(): Promise<BlogState | null> {
    const row = await db.prepare("SELECT payload FROM blog_state WHERE state_id = ?1").bind(STATE_ID).first();
    return row?.payload ? (JSON.parse(row.payload) as BlogState) : null;
  }

  async function writeState(state: BlogState): Promise<void> {
    await db.prepare("INSERT INTO blog_state (state_id, payload, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(state_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .bind(STATE_ID, JSON.stringify(state), new Date().toISOString())
      .run();
  }

  async function withApi<T>(action: (api: PublicBlogApi) => T, { write = false }: { write?: boolean } = {}): Promise<T> {
    const memory: StorageAdapter = createMemoryStorage((await readState()) || seedData);
    const api = createPublicBlogApi({ storage: memory, seedData, now });
    const result = await action(api);
    if (write) await writeState(memory.read() as BlogState);
    return result;
  }

  return {
    addComment: (articleId, body, session) => withApi((api) => api.addComment(articleId, body, session), { write: true }),
    getCommentsForArticle: (articleId) => withApi((api) => api.getCommentsForArticle(articleId)),
    getPublishedArticleBySlug: (slug) => withApi((api) => api.getPublishedArticleBySlug(slug)),
    getArticleReaderPayload: (slug) => withApi((api) => api.getArticleReaderPayload(slug)),
    getPublishedArtworks: () => withApi((api) => api.getPublishedArtworks()),
    getPublishedArtworkBySlug: (slug) => withApi((api) => api.getPublishedArtworkBySlug(slug)),
    getPublishedArtworkAsset: (slug, assetId, variant) => withApi((api) => api.getPublishedArtworkAsset(slug, assetId, variant)),
    getSnapshot: () => withApi((api) => api.getSnapshot()),
    queryPublishedArticles: (query) => withApi((api) => api.queryPublishedArticles(query))
  };
}
