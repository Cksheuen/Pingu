// Artwork 配置注册表：路由 → orbital plume procedural 参数 + SVG fallback。
// 所有场景共享 900×640 构图、密度与语义减法通道，因此 route morph 可连续插值。

import type { RouteName } from "../types";
import type { DestRect } from "./svgRenderer";
import type {
  OrbitalPlumeParams,
  PlumeChannels,
  PlumeDensity,
  SafeZone,
} from "./orbitalPlume";
import {
  DEFAULT_CHANNELS,
  DESKTOP_DENSITY,
  MOBILE_DENSITY,
} from "./orbitalPlume";

export const ARTWORK_OPERATOR_ID = "orbital-plume-canvas2d-v1" as const;

// 有 hero + artwork 的 Tab 路由（article 是详情页，不在此列）
export type TabRoute = Extract<RouteName, "home" | "archive" | "now" | "gallery">;

export const TAB_ROUTES: TabRoute[] = ["home", "archive", "now", "gallery"];

export function isTabRoute(name: RouteName): name is TabRoute {
  return name === "home" || name === "archive" || name === "now" || name === "gallery";
}

export type ArtworkSource =
  | {
      kind: "procedural";
      operator: typeof ARTWORK_OPERATOR_ID;
      params: OrbitalPlumeParams;
    }
  | {
      kind: "vector";
      src: string;
      topologyId?: string;
    }
  | {
      kind: "raster";
      src: string;
    };

export interface ArtworkMobileFrame {
  widthRatio: number;
  alignX: number;
  centerY: number;
}

export interface ArtworkComposition {
  width: number;
  height: number;
  safeZones: SafeZone[];
  /** 素材无关的移动端画框；宽高比始终继承 composition。 */
  mobileFrame?: ArtworkMobileFrame;
}

export interface ArtworkMotion {
  channels: PlumeChannels;
  routeMorphDurationMs: number;
}

export interface ArtworkQuality {
  dprCap: number;
  mobileBreakpoint: number;
  desktopDensity: PlumeDensity;
  mobileDensity: PlumeDensity;
}

export interface ArtworkFallback {
  coreIcon: string;
  poster?: string;
}

export interface ArtworkConfig {
  id: string;
  source: ArtworkSource;
  composition: ArtworkComposition;
  motion: ArtworkMotion;
  quality: ArtworkQuality;
  fallback: ArtworkFallback;
}

const SHARED_MOBILE_FRAME: ArtworkMobileFrame = {
  widthRatio: 0.9,
  alignX: 1,
  centerY: 0.53,
};

const SHARED_COMPOSITION: ArtworkComposition = {
  width: 900,
  height: 640,
  safeZones: [{ x: 32, y: 64, w: 500, h: 512 }],
  mobileFrame: SHARED_MOBILE_FRAME,
};

const SHARED_MOTION: ArtworkMotion = {
  channels: DEFAULT_CHANNELS,
  routeMorphDurationMs: 700,
};

const SHARED_QUALITY: ArtworkQuality = {
  dprCap: 2,
  mobileBreakpoint: 720,
  desktopDensity: DESKTOP_DENSITY,
  mobileDensity: MOBILE_DENSITY,
};

const HOME_PARAMS: OrbitalPlumeParams = {
  seed: 10101,
  feathers: {
    length: 0.24,
    width: 0.035,
    taper: 1.1,
    curl: 0.35,
    jitter: 0.12,
    distribution: { spread: 0.42, jitter: 0.06 },
    drift: { amplitude: 0.025, frequency: 2.2 },
  },
  core: { x: 0.22, y: -0.04, r: 0.088 },
  planet: { lightAngle: -0.9, atmosphere: 0.7, bands: 0, bandTilt: 0 },
  orbit: { rx: 0.18, ry: 0.08, rotation: -0.35 },
  barbs: { length: 0.09, sweep: 0.05, curl: 0.2, taper: 0.75 },
  stars: { spread: 0.42, jitter: 0.25 },
  curl: { amplitude: 0.006, frequency: 16 },
  colors: {
    core: "#4338ca",
    ring: "#22d3ee",
    spine: "#4f46e5",
    barb: "#67e8f9",
    star: "#a5f3fc",
    dust: "#d97757",
  },
};

const ARCHIVE_PARAMS: OrbitalPlumeParams = {
  seed: 10202,
  feathers: {
    length: 0.2,
    width: 0.03,
    taper: 1.3,
    curl: 0.2,
    jitter: 0.06,
    distribution: { spread: 0.38, jitter: 0.05 },
    drift: { amplitude: 0.02, frequency: 1.8 },
  },
  core: { x: 0.24, y: 0.08, r: 0.078 },
  planet: { lightAngle: -0.6, atmosphere: 0.4, bands: 3, bandTilt: 0.25 },
  orbit: { rx: 0.16, ry: 0.06, rotation: -0.15 },
  barbs: { length: 0.07, sweep: 0.03, curl: 0.14, taper: 0.85 },
  stars: { spread: 0.4, jitter: 0.18 },
  curl: { amplitude: 0.004, frequency: 12 },
  colors: {
    core: "#1f3a5f",
    ring: "#94a3b8",
    spine: "#334155",
    barb: "#64748b",
    star: "#cbd5e1",
    dust: "#a45a52",
  },
};

const NOW_PARAMS: OrbitalPlumeParams = {
  seed: 10303,
  feathers: {
    length: 0.28,
    width: 0.04,
    taper: 0.9,
    curl: 0.5,
    jitter: 0.2,
    distribution: { spread: 0.46, jitter: 0.07 },
    drift: { amplitude: 0.035, frequency: 2.8 },
  },
  core: { x: 0.2, y: -0.02, r: 0.095 },
  planet: { lightAngle: -1.1, atmosphere: 0.85, bands: 2, bandTilt: -0.3 },
  orbit: { rx: 0.2, ry: 0.09, rotation: -0.5 },
  barbs: { length: 0.12, sweep: 0.09, curl: 0.32, taper: 0.65 },
  stars: { spread: 0.46, jitter: 0.32 },
  curl: { amplitude: 0.008, frequency: 20 },
  colors: {
    core: "#e76f51",
    ring: "#a3b18a",
    spine: "#22303c",
    barb: "#8a9a5b",
    star: "#f4a261",
    dust: "#ef8354",
  },
};

const GALLERY_PARAMS: OrbitalPlumeParams = {
  seed: 10404,
  feathers: {
    length: 0.26,
    width: 0.038,
    taper: 1.0,
    curl: 0.42,
    jitter: 0.16,
    distribution: { spread: 0.44, jitter: 0.06 },
    drift: { amplitude: 0.03, frequency: 2.5 },
  },
  core: { x: 0.26, y: -0.06, r: 0.09 },
  planet: { lightAngle: -0.8, atmosphere: 0.75, bands: 4, bandTilt: 0.4 },
  orbit: { rx: 0.19, ry: 0.075, rotation: 0.4 },
  barbs: { length: 0.1, sweep: 0.06, curl: 0.24, taper: 0.7 },
  stars: { spread: 0.48, jitter: 0.28 },
  curl: { amplitude: 0.007, frequency: 18 },
  colors: {
    core: "#6d28d9",
    ring: "#22d3ee",
    spine: "#3b82f6",
    barb: "#8b5cf6",
    star: "#67e8f9",
    dust: "#60a5fa",
  },
};

export const ARTWORK_BY_ROUTE: Record<TabRoute, ArtworkConfig> = {
  home: {
    id: "home-orbital-plume-canvas2d-v1",
    source: {
      kind: "procedural",
      operator: ARTWORK_OPERATOR_ID,
      params: HOME_PARAMS,
    },
    composition: SHARED_COMPOSITION,
    motion: SHARED_MOTION,
    quality: SHARED_QUALITY,
    fallback: {
      coreIcon: "/public/assets/sketch-orbit.svg",
      poster: "/public/assets/sketch-orbit.svg",
    },
  },
  archive: {
    id: "archive-orbital-plume-canvas2d-v1",
    source: {
      kind: "procedural",
      operator: ARTWORK_OPERATOR_ID,
      params: ARCHIVE_PARAMS,
    },
    composition: SHARED_COMPOSITION,
    motion: SHARED_MOTION,
    quality: SHARED_QUALITY,
    fallback: {
      coreIcon: "/public/assets/sketch-grid.svg",
      poster: "/public/assets/sketch-grid.svg",
    },
  },
  now: {
    id: "now-orbital-plume-canvas2d-v1",
    source: {
      kind: "procedural",
      operator: ARTWORK_OPERATOR_ID,
      params: NOW_PARAMS,
    },
    composition: SHARED_COMPOSITION,
    motion: SHARED_MOTION,
    quality: SHARED_QUALITY,
    fallback: {
      coreIcon: "/public/assets/sketch-now.svg",
      poster: "/public/assets/sketch-now.svg",
    },
  },
  gallery: {
    id: "gallery-orbital-plume-canvas2d-v1",
    source: {
      kind: "procedural",
      operator: ARTWORK_OPERATOR_ID,
      params: GALLERY_PARAMS,
    },
    composition: SHARED_COMPOSITION,
    motion: SHARED_MOTION,
    quality: SHARED_QUALITY,
    fallback: {
      coreIcon: "/public/assets/sketch-gallery.svg",
      poster: "/public/assets/sketch-gallery.svg",
    },
  },
};

export function getArtworkConfig(name: RouteName): ArtworkConfig {
  if (isTabRoute(name)) return ARTWORK_BY_ROUTE[name];
  return ARTWORK_BY_ROUTE.home;
}

export function getArtworkBrandSrc(config: ArtworkConfig): string {
  return config.fallback.coreIcon;
}

export function getArtworkDensity(config: ArtworkConfig, viewportWidth: number): PlumeDensity {
  return viewportWidth <= config.quality.mobileBreakpoint
    ? config.quality.mobileDensity
    : config.quality.desktopDensity;
}

function sanitizeUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * 把素材统一放入响应式 hero 画框；桌面与未配置移动画框时保持原测量值。
 * 画框比例来自 composition，因此 procedural / vector / raster 可共享替换契约。
 */
export function resolveArtworkHeroFrame(
  config: ArtworkConfig,
  hero: DestRect,
  viewportWidth: number
): DestRect {
  const mobileFrame = config.composition.mobileFrame;
  if (
    !mobileFrame ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth < 0 ||
    viewportWidth > config.quality.mobileBreakpoint
  ) {
    return hero;
  }

  const heroX = Number.isFinite(hero.x) ? hero.x : 0;
  const heroY = Number.isFinite(hero.y) ? hero.y : 0;
  const heroW = Number.isFinite(hero.w) && hero.w >= 0 ? hero.w : 0;
  const heroH = Number.isFinite(hero.h) && hero.h >= 0 ? hero.h : 0;
  const { width: compositionW, height: compositionH } = config.composition;
  const aspect =
    Number.isFinite(compositionW) &&
    Number.isFinite(compositionH) &&
    compositionW > 0 &&
    compositionH > 0
      ? compositionW / compositionH
      : 1;

  const widthRatio = sanitizeUnit(mobileFrame.widthRatio, 1);
  const alignX = sanitizeUnit(mobileFrame.alignX, 0);
  const centerY = sanitizeUnit(mobileFrame.centerY, 0.5);
  const w = Math.min(heroW * widthRatio, heroH * aspect);
  const h = w / aspect;
  const x = heroX + (heroW - w) * alignX;
  const unclampedY = heroY + heroH * centerY - h / 2;
  const y = Math.min(heroY + heroH - h, Math.max(heroY, unclampedY));

  return { x, y, w, h };
}
