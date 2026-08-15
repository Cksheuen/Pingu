import type { PublicStatus } from "../types";

const LOCALE_STORAGE_KEY = "eva-blog-public-locale";
const LOCALES = new Set(["zh", "en"]);

export type Language = "zh" | "en";

export interface Locale {
  readonly language: Language;
  setLanguage(nextLanguage: string): Language;
  t(key: string, values?: Record<string, unknown>): string;
  formatDate(value?: string | null): string;
  formatCompactNumber(value: number): string;
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    "brand.tagline": "field notes · folio · signal",
    "brand.home": "Eva Blog home",
    "nav.label": "Public blog sections",
    "nav.reader": "Reader",
    "nav.archive": "Archive",
    "nav.now": "Now",
    "nav.gallery": "Sketchbook",
    "public.readOnly": "Public / read only",
    "locale.label": "Language",
    "locale.zh": "中文",
    "locale.en": "EN",
    "footer.reader": "Eva Blog / public reader",
    "footer.scope": "published words · selected signals · visual work",
    "dock.label": "Eva Blog / field notes · folio · signal",
    "dock.expand": "Open introduction",
    "home.kicker": "A SMALL OBSERVATORY FOR MAKING",
    "home.title": "Notes from the workbench,<br><em>drawn in public.</em>",
    "home.intro": "A living archive of systems, small observations, and images that deserve a slower look.",
    "home.latest": "Read the latest note",
    "home.archive": "Open the archive",
    "home.gallery": "Visit the sketchbook",
    "home.plate": "PLATE 01 / CURRENT STUDY",
    "home.fallbackArtwork": "Silverwing cover study",
    "home.recent": "RECENT FIELD NOTES",
    "home.start": "Start with a thought.",
    "home.viewArchive": "View archive →",
    "home.opening": "Opening the reader…",
    "home.empty": "No public notes yet.",
    "home.follow": "Follow the live thread →",
    "archive.kicker": "PUBLIC ARCHIVE / {count} NOTES",
    "archive.title": "All the notes,<br><em>in their own weather.</em>",
    "archive.intro": "Search by title, tag, series, or a phrase from the manuscript. Published and due-now entries only.",
    "archive.search": "Search archive",
    "archive.placeholder": "Try “publishing” or “local-first”",
    "archive.empty": "No published notes match that search.",
    "archive.index": "INDEX",
    "archive.year": "By year",
    "archive.tag": "By tag",
    "archive.series": "Series",
    "archive.notes": "{count} notes",
    "archive.parts": "{count} parts",
    "now.kicker": "LIVE THREAD / PUBLIC SIGNALS",
    "now.title": "What is moving<br><em>right now.</em>",
    "now.intro": "Small, deliberate signals from the author’s current orbit. Token details and private source metadata never cross this boundary.",
    "now.empty": "No public signals yet.",
    "gallery.kicker": "SKETCHBOOK / VISUAL NOTES",
    "gallery.title": "Pieces that refuse<br><em>to stay in the margin.</em>",
    "gallery.intro": "Drawings, studies, and visual fragments share the same publishing loop as the writing: a private studio first, a carefully chosen display derivative in public.",
    "gallery.empty": "The sketchbook is still being assembled.",
    "gallery.opening": "Opening the sketchbook…",
    "gallery.unavailable": "That visual note is not public.",
    "gallery.back": "← Sketchbook",
    "gallery.visualStudy": "visual study",
    "gallery.artistNote": "ARTIST NOTE",
    "gallery.fallbackNote": "A visual note from the studio.",
    "gallery.rights": "All rights reserved",
    "gallery.related": "Read the related note ↗",
    "gallery.openStudy": "open study",
    "reader.loading": "Loading the public reader…",
    "reader.unavailable": "That note is not public.",
    "reader.archive": "Archive",
    "reader.fieldNotes": "Field notes",
    "reader.minRead": "{count} min read",
    "reader.onThisPage": "ON THIS PAGE",
    "reader.digest": "AI digest",
    "reader.summaryPending": "Summary will be generated when the article is published.",
    "reader.pending": "pending",
    "reader.copy": "Copy reader link",
    "reader.copied": "Reader link copied",
    "reader.sourceChars": "{count} source chars",
    "reader.continue": "CONTINUE THE THREAD",
    "reader.minutes": "{count} min →",
    "reader.backToTop": "Back to top",
    "comments.kicker": "READER COMMS",
    "comments.title": "Comments",
    "comments.loading": "Loading comments…",
    "comments.empty": "No comments yet.",
    "comments.placeholder": "Write a comment",
    "comments.post": "Post comment",
    "status.empty": "No current status has been synced.",
    "status.listening": "Listening",
    "status.paused": "Paused",
    "status.working": "Working",
    "status.token": "Token usage",
    "status.active": "Active",
    "status.meta.track": "track",
    "status.meta.artist": "artist",
    "status.meta.service": "service",
    "status.meta.usagePercent": "usage",
    "status.meta.unit": "unit",
    "time.unscheduled": "Unscheduled",
    "seo.home": "Eva Blog — field notes, folio, signal",
    "seo.archive": "Archive — Eva Blog",
    "seo.now": "Now — Eva Blog",
    "seo.gallery": "Sketchbook — Eva Blog",
    "seo.description": "Eva Blog — field notes, public signals, and visual studies."
  },
  zh: {
    "brand.tagline": "工作笔记 · 画稿 · 近况",
    "brand.home": "Eva Blog 首页",
    "nav.label": "公开博客栏目",
    "nav.reader": "阅读",
    "nav.archive": "归档",
    "nav.now": "此刻",
    "nav.gallery": "画稿簿",
    "public.readOnly": "公开 / 只读",
    "locale.label": "语言",
    "locale.zh": "中文",
    "locale.en": "EN",
    "footer.reader": "Eva Blog / 公开读者站",
    "footer.scope": "已发布文字 · 精选近况 · 视觉作品",
    "dock.label": "Eva Blog / 工作笔记 · 画稿 · 近况",
    "dock.expand": "展开介绍",
    "home.kicker": "一座小小的创作观测台",
    "home.title": "工作台上的笔记，<br><em>也在公开地被画下。</em>",
    "home.intro": "关于系统、细小观察，以及那些值得放慢速度看的图像的持续归档。",
    "home.latest": "阅读最新笔记",
    "home.archive": "查看归档",
    "home.gallery": "走进画稿簿",
    "home.plate": "画板 01 / 当前习作",
    "home.fallbackArtwork": "Silverwing 封面习作",
    "home.recent": "近期工作笔记",
    "home.start": "从一个念头开始。",
    "home.viewArchive": "浏览归档 →",
    "home.opening": "正在打开读者站…",
    "home.empty": "暂时还没有公开笔记。",
    "home.follow": "沿着此刻继续阅读 →",
    "archive.kicker": "公开归档 / {count} 篇笔记",
    "archive.title": "所有笔记，<br><em>都有自己的天气。</em>",
    "archive.intro": "可按标题、标签、系列或正文片段检索。仅展示已发布或已到发布时间的内容。",
    "archive.search": "检索归档",
    "archive.placeholder": "试试“发布”或“本地优先”",
    "archive.empty": "没有与这次检索匹配的公开笔记。",
    "archive.index": "索引",
    "archive.year": "按年份",
    "archive.tag": "按标签",
    "archive.series": "系列",
    "archive.notes": "{count} 篇",
    "archive.parts": "{count} 节",
    "now.kicker": "实时线索 / 公开近况",
    "now.title": "此刻正在发生的，<br><em>是什么。</em>",
    "now.intro": "来自作者当下工作轨道的一些克制信号。Token 详情和私有来源信息不会越过这道边界。",
    "now.empty": "暂时还没有公开近况。",
    "gallery.kicker": "画稿簿 / 视觉笔记",
    "gallery.title": "不愿只待在<br><em>页边空白里的作品。</em>",
    "gallery.intro": "画稿、习作与视觉碎片，和文字共享同一条发布路径：先留在私有工作室，再以经过挑选的展示版本面向读者。",
    "gallery.empty": "画稿簿仍在整理中。",
    "gallery.opening": "正在打开画稿簿…",
    "gallery.unavailable": "这条视觉笔记尚未公开。",
    "gallery.back": "← 返回画稿簿",
    "gallery.visualStudy": "视觉习作",
    "gallery.artistNote": "作者手记",
    "gallery.fallbackNote": "一则来自工作室的视觉笔记。",
    "gallery.rights": "保留所有权利",
    "gallery.related": "阅读相关笔记 ↗",
    "gallery.openStudy": "开放习作",
    "reader.loading": "正在加载公开读者站…",
    "reader.unavailable": "这篇笔记尚未公开。",
    "reader.archive": "归档",
    "reader.fieldNotes": "工作笔记",
    "reader.minRead": "约 {count} 分钟阅读",
    "reader.onThisPage": "本页目录",
    "reader.digest": "AI 摘要",
    "reader.summaryPending": "文章发布时会生成摘要。",
    "reader.pending": "等待生成",
    "reader.copy": "复制阅读链接",
    "reader.copied": "已复制阅读链接",
    "reader.sourceChars": "{count} 个源文字元",
    "reader.continue": "继续这条线索",
    "reader.minutes": "约 {count} 分钟 →",
    "reader.backToTop": "回到顶部",
    "comments.kicker": "读者交流",
    "comments.title": "评论",
    "comments.loading": "正在加载评论…",
    "comments.empty": "还没有评论。",
    "comments.placeholder": "写下你的评论",
    "comments.post": "发布评论",
    "status.empty": "尚未同步公开近况。",
    "status.listening": "正在听",
    "status.paused": "已暂停",
    "status.working": "正在工作",
    "status.token": "Token 使用情况",
    "status.active": "进行中",
    "status.meta.track": "曲目",
    "status.meta.artist": "音乐人",
    "status.meta.service": "来源",
    "status.meta.usagePercent": "用量",
    "status.meta.unit": "单位",
    "time.unscheduled": "未排期",
    "seo.home": "Eva Blog — 工作笔记、画稿与近况",
    "seo.archive": "归档 — Eva Blog",
    "seo.now": "此刻 — Eva Blog",
    "seo.gallery": "画稿簿 — Eva Blog",
    "seo.description": "Eva Blog — 工作笔记、公开近况与视觉习作。"
  }
};

interface CreateLocaleOptions {
  browserLanguage?: string;
  storage?: Storage | null;
}

export function createLocale({ browserLanguage = globalThis.navigator?.language, storage = getBrowserStorage() }: CreateLocaleOptions = {}): Locale {
  let language = normalizeLocale(readStoredLocale(storage)) || detectLocale(browserLanguage);

  return {
    get language() {
      return language;
    },
    setLanguage(nextLanguage: string): Language {
      language = normalizeLocale(nextLanguage) || language;
      writeStoredLocale(storage, language);
      return language;
    },
    t(key: string, values?: Record<string, unknown>): string {
      return interpolate(COPY[language]?.[key] || COPY.en[key] || key, values);
    },
    formatDate(value?: string | null): string {
      if (!value) return this.t("time.unscheduled");
      return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
    },
    formatCompactNumber(value: number): string {
      return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
    }
  };
}

export function detectLocale(language?: string | null): Language {
  return String(language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

type StatusMeta = {
  playing?: boolean;
  track?: string;
  artist?: string;
  usagePercent?: number;
  usedTokens?: number;
  limitTokens?: number;
  unit?: string;
};

export function describeLocalizedStatus(status: PublicStatus | null | undefined, locale: Locale): string {
  if (!status) return locale.t("status.empty");
  const meta = status.meta as StatusMeta | undefined;
  const kind = status.kind === "song"
    ? meta?.playing === false ? locale.t("status.paused") : locale.t("status.listening")
    : status.kind === "work"
      ? locale.t("status.working")
      : status.kind === "token"
        ? locale.t("status.token")
        : locale.t("status.active");
  const title = status.kind === "song"
    ? [meta?.track || status.title, meta?.artist].filter(Boolean).join(" · ")
    : status.kind === "token"
      ? formatTokenUsage(meta, status.title, locale)
      : status.title;
  return `${kind}: ${title}${status.details ? ` — ${status.details}` : ""}`;
}

function formatTokenUsage(meta: StatusMeta | undefined, fallback: string | undefined, locale: Locale): string {
  if (meta?.usagePercent !== undefined) return `${meta.usagePercent}%`;
  if (!meta?.usedTokens && meta?.usedTokens !== 0) return fallback || "";
  const used = locale.formatCompactNumber(meta.usedTokens);
  const limit = meta.limitTokens === undefined ? "" : ` / ${locale.formatCompactNumber(meta.limitTokens)}`;
  return `${used}${limit} ${meta.unit || "tokens"}`;
}

function interpolate(template: string, values: Record<string, unknown> = {}): string {
  return String(template).replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

function normalizeLocale(value: string | null | undefined): Language | null {
  return LOCALES.has(value ?? "") ? (value as Language) : null;
}

function getBrowserStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStoredLocale(storage: Storage | null | undefined): string | null {
  try {
    return storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredLocale(storage: Storage | null | undefined, value: string): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    // Storage may be unavailable in private browsing; browser-language fallback remains valid.
  }
}
