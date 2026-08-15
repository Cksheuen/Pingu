// 共享领域类型：存储层记录（字段宽松，兼容 seed 与测试夹具）与公开层记录（严格）。

// ── 存储层记录 ─────────────────────────────────────────────

export interface ArticleSummary {
  provider?: string;
  text?: string;
  generatedAt?: string;
}

export interface ArticleSeries {
  title: string;
  slug: string;
  order?: number;
}

export interface ArticleCover {
  src: string;
  alt?: string;
  focalPoint?: string;
}

// 存储中的文章记录。除 id/title/slug/content/status 外均可缺省，
// 以兼容 seed 数据与测试夹具中的部分字段对象。
export interface Article {
  id: string;
  title: string;
  slug: string;
  content: string;
  status: string;
  tags?: string[];
  series?: ArticleSeries | null;
  relatedSlugs?: string[];
  seoDescription?: string;
  publishedAt?: string | null;
  scheduledAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  excerpt?: string;
  readingMinutes?: number;
  summary?: ArticleSummary | null;
  cover?: ArticleCover | null;
}

export interface ArtworkDimensions {
  width: number;
  height: number;
}

export interface ArtworkAsset {
  id: string;
  originalKey?: string;
  displayKey?: string;
  thumbKey?: string;
  publicSrc?: string;
  publicThumbSrc?: string;
  altText?: string;
  width?: number | null;
  height?: number | null;
  ratio?: number | null;
  kind?: string;
  mimeType?: string;
}

// 存储中的画作记录。
export interface Artwork {
  id: string;
  title: string;
  slug: string;
  status?: string;
  publishedAt?: string | null;
  scheduledAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  caption?: string;
  artistNote?: string;
  altText?: string;
  medium?: string;
  dimensions?: ArtworkDimensions | null;
  tags?: string[];
  series?: string | null;
  relatedArticleSlug?: string;
  license?: string;
  assets?: ArtworkAsset[];
}

export interface CommentAuthor {
  id: string | number;
  login: string;
  name: string;
  avatarUrl: string;
}

export interface Comment {
  id: string;
  articleId: string;
  body: string;
  author: CommentAuthor;
  createdAt: string;
}

// 登录会话（GitHub OAuth 成功后写入签名 cookie）。
export interface Session {
  id: string | number;
  login: string;
  name?: string;
  avatarUrl?: string;
  provider?: string;
}

// 公开状态条目（now 页信号）。meta 形状随 kind 变化，保持宽松。
// id/createdAt 由管理端写入并随公开接口透传，消费方（NowView）用作 key 与回退时间。
export interface PublicStatus {
  id?: string | number;
  kind?: string;
  title?: string;
  details?: string;
  isPublic?: boolean;
  updatedAt?: string;
  createdAt?: string;
  expiresAt?: string | null;
  meta?: Record<string, unknown>;
}

export interface BlogState {
  articles: Article[];
  artworks: Artwork[];
  comments: Comment[];
  statuses: PublicStatus[];
}

// ── 公开层记录（API 与组件消费的严格形状）──────────────────

export interface PublicArticle {
  id: string;
  title: string;
  slug: string;
  content: string;
  tags: string[];
  status: "published";
  publishedAt: string;
  createdAt?: string;
  updatedAt?: string;
  excerpt: string;
  readingMinutes: number;
  summary: ArticleSummary | null;
  series: ArticleSeries | null;
  relatedSlugs: string[];
  cover: (Required<Pick<ArticleCover, "src" | "alt" | "focalPoint">>) | null;
  seoDescription: string;
}

export interface PublicArtworkAsset {
  id: string;
  altText: string;
  width: number | null;
  height: number | null;
  ratio: number | null;
  kind: string;
  src: string;
  thumbSrc: string;
}

export interface PublicArtwork {
  id: string;
  title: string;
  slug: string;
  publishedAt?: string;
  caption: string;
  artistNote: string;
  altText: string;
  medium: string;
  dimensions: ArtworkDimensions | null;
  tags: string[];
  series: string | null;
  relatedArticleSlug: string;
  license: string;
  assets: PublicArtworkAsset[];
}

// 文章阅读器负载：公开文章 + 目录 + 相关文章。
export interface ArticleReaderPayload extends PublicArticle {
  outline: ArticleOutlineItem[];
  related: PublicArticle[];
}

export interface ArticleOutlineItem {
  depth: number;
  text: string;
  id: string;
  line?: number;
}

// ── 存储适配层 ─────────────────────────────────────────────

export interface StorageAdapter {
  read(): unknown;
  write(value: unknown): void;
  clear?(): void;
}

// ── 路由 ───────────────────────────────────────────────────

export type RouteName = "home" | "article" | "archive" | "now" | "gallery";

export interface Route {
  name: RouteName;
  artworkSlug?: string | null;
}

export interface RouteLocation {
  route: Route;
  selectedSlug: string | null;
}
