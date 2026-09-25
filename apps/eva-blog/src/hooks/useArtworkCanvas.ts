// useArtworkCanvas：Canvas 绘制循环，支持路由切换时的 liquid morph。
// 负责素材加载、orbital plume 准备、滚动驱动绘制、圆角裁剪、软边羽化。
// morph 时按素材能力选择 procedural topology morph、vector topology morph 或 composited crossfade。

import { useRef, useEffect, type RefObject } from "react";
import { useScroll, useTransform, useReducedMotion, type MotionValue } from "framer-motion";
import {
  clamp01,
  coverTransform,
  easeInOutCubic,
  fetchScene,
  lerp,
  renderScene,
  renderSceneMorph,
  sceneState,
  smoothstep,
  type DestRect,
  type Scene,
} from "../lib/svgRenderer";
import {
  drawOrbitalPlume,
  drawPlanetSurfaceOverlay,
  plumeChrome,
  plumeTopologyCompatible,
  prepareOrbitalPlume,
  type PreparedPlume,
} from "../lib/orbitalPlume";
import { getPlanetSurface, planetSurfaceType } from "../lib/planetTexture";
import {
  getArtworkDensity,
  resolveArtworkHeroFrame,
  type ArtworkConfig,
} from "../lib/artworkConfig";
import { useViewportHeight } from "./useViewportHeight";
import type { HeroMeasurements, ArtworkMotion } from "./heroTypes";

type DensityTier = "mobile" | "desktop";

type PreparedArtwork =
  | { kind: "procedural"; plume: PreparedPlume; surface: HTMLCanvasElement | null }
  | { kind: "vector"; scene: Scene; topologyId?: string }
  | { kind: "raster"; image: HTMLImageElement; width: number; height: number };

interface CrossfadeBuffer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export function resolveCanvasDpr(devicePixelRatio: number, cap: number): number {
  const safeCap = Number.isFinite(cap) && cap >= 1 ? cap : 1;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(safeCap, Math.max(1, dpr));
}

// 手动圆角矩形路径（兼容不支持 ctx.roundRect 的浏览器）
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function preparePlume(config: ArtworkConfig, viewportWidth: number): PreparedPlume {
  const source = config.source;
  if (source.kind !== "procedural") {
    throw new Error("preparePlume expects a procedural artwork source");
  }

  return prepareOrbitalPlume(
    source.params,
    config.composition.width,
    config.composition.height,
    getArtworkDensity(config, viewportWidth),
    config.motion.channels,
    config.composition.safeZones
  );
}

/** 星球表面纹理：按 seed + surfaceType + baseHex 缓存；WebGL 不可用时静默返回 null */
function preparePlanetSurface(config: ArtworkConfig): HTMLCanvasElement | null {
  const source = config.source;
  if (source.kind !== "procedural") return null;
  return getPlanetSurface(
    source.params.seed,
    planetSurfaceType(source.params.planet.bands),
    source.params.colors.core
  );
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";

    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        reject(new Error(`Artwork image has invalid dimensions: ${src}`));
        return;
      }
      resolve(image);
    };

    image.onerror = () => reject(new Error(`Artwork image load failed: ${src}`));
    image.src = src;
  });
}

function drawPreparedArtwork(
  ctx: CanvasRenderingContext2D,
  asset: PreparedArtwork,
  s: number,
  dest: DestRect
): void {
  switch (asset.kind) {
    case "procedural": {
      const cover = coverTransform(
        asset.plume.sceneW,
        asset.plume.sceneH,
        dest.x,
        dest.y,
        dest.w,
        dest.h
      );
      if (!cover) return;

      ctx.save();
      ctx.translate(dest.x, dest.y);
      ctx.scale(cover.scale, cover.scale);
      ctx.translate(-cover.sx, -cover.sy);
      drawOrbitalPlume(ctx, asset.plume, s, undefined, { surface: asset.surface });
      ctx.restore();
      return;
    }

    case "vector": {
      renderScene(ctx, asset.scene, sceneState(asset.scene, s), dest);
      return;
    }

    case "raster": {
      const cover = coverTransform(asset.width, asset.height, dest.x, dest.y, dest.w, dest.h);
      if (!cover) return;

      ctx.save();
      ctx.translate(dest.x, dest.y);
      ctx.scale(cover.scale, cover.scale);
      ctx.translate(-cover.sx, -cover.sy);
      ctx.drawImage(
        asset.image,
        cover.sx,
        cover.sy,
        cover.sw,
        cover.sh,
        cover.sx,
        cover.sy,
        cover.sw,
        cover.sh
      );
      ctx.restore();
      return;
    }
  }
}

function applyFeather(
  ctx: CanvasRenderingContext2D,
  dest: DestRect,
  feather: number
): void {
  if (feather <= 0.5) return;

  ctx.globalCompositeOperation = "destination-out";

  let g = ctx.createLinearGradient(0, dest.y, 0, dest.y + feather);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(dest.x, dest.y, dest.w, feather);

  g = ctx.createLinearGradient(0, dest.y + dest.h - feather, 0, dest.y + dest.h);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = g;
  ctx.fillRect(dest.x, dest.y + dest.h - feather, dest.w, feather);

  g = ctx.createLinearGradient(dest.x, 0, dest.x + feather, 0);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(dest.x, dest.y, feather, dest.h);

  g = ctx.createLinearGradient(dest.x + dest.w - feather, 0, dest.x + dest.w, 0);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = g;
  ctx.fillRect(dest.x + dest.w - feather, dest.y, feather, dest.h);

  ctx.globalCompositeOperation = "source-over";
}

export interface UseArtworkCanvasOptions {
  active: boolean;
  measured: boolean;
  measurementsRef: RefObject<HeroMeasurements | null>;
  config: ArtworkConfig;
  prevConfig: ArtworkConfig | null;
  morphT: MotionValue<number>;
}

export interface UseArtworkCanvasResult {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  artwork: ArtworkMotion;
}

export function useArtworkCanvas(options: UseArtworkCanvasOptions): UseArtworkCanvasResult {
  const { active, measured, measurementsRef, config, prevConfig, morphT } = options;
  const { scrollY } = useScroll();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const reducedRef = useRef<boolean | null>(reducedMotion);
  reducedRef.current = reducedMotion;
  const vhRef = useViewportHeight();

  const assetRef = useRef<PreparedArtwork | null>(null);
  const prevAssetRef = useRef<PreparedArtwork | null>(null);
  const requestSeqRef = useRef(0);
  const lastConfigIdRef = useRef("");
  const tierRef = useRef<DensityTier | null>(null);
  const scheduleDrawRef = useRef<(() => void) | null>(null);

  const configRef = useRef(config);
  configRef.current = config;
  const prevConfigRef = useRef(prevConfig);
  prevConfigRef.current = prevConfig;

  // 路由变化：current 移入 prev，再按 source 契约准备 next asset。
  useEffect(() => {
    if (!active) return;
    if (lastConfigIdRef.current === config.id) return;

    prevAssetRef.current = assetRef.current;
    assetRef.current = null;
    lastConfigIdRef.current = config.id;

    const requestId = ++requestSeqRef.current;
    const isCurrentRequest = (): boolean => requestSeqRef.current === requestId;
    const viewportWidth = window.innerWidth;
    tierRef.current =
      viewportWidth <= config.quality.mobileBreakpoint ? "mobile" : "desktop";

    const loadFallbackPoster = (): void => {
      const poster = config.fallback.poster;
      if (!poster) return;

      loadImageElement(poster)
        .then((image) => {
          if (!isCurrentRequest()) return;
          assetRef.current = {
            kind: "raster",
            image,
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
          if (morphT.get() >= 1) prevAssetRef.current = null;
          scheduleDrawRef.current?.();
        })
        .catch(() => {
          if (!isCurrentRequest()) return;
          scheduleDrawRef.current?.();
        });
    };

    if (config.source.kind === "procedural") {
      assetRef.current = {
        kind: "procedural",
        plume: preparePlume(config, viewportWidth),
        surface: preparePlanetSurface(config),
      };
      scheduleDrawRef.current?.();
      return;
    }

    if (config.source.kind === "vector") {
      const topologyId = config.source.topologyId;
      fetchScene(config.source.src)
        .then((scene) => {
          if (!isCurrentRequest()) return;
          assetRef.current = { kind: "vector", scene, topologyId };
          if (morphT.get() >= 1) prevAssetRef.current = null;
          scheduleDrawRef.current?.();
        })
        .catch(() => {
          if (!isCurrentRequest()) return;
          loadFallbackPoster();
        });
      return;
    }

    loadImageElement(config.source.src)
      .then((image) => {
        if (!isCurrentRequest()) return;
        assetRef.current = {
          kind: "raster",
          image,
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
        if (morphT.get() >= 1) prevAssetRef.current = null;
        scheduleDrawRef.current?.();
      })
      .catch(() => {
        if (!isCurrentRequest()) return;
        loadFallbackPoster();
      });
  }, [active, config]);

  // morph 完成后清理 prev asset
  useEffect(() => {
    if (!prevConfig) return;

    if (morphT.get() >= 1) {
      if (assetRef.current) prevAssetRef.current = null;
      return;
    }

    const unsub = morphT.on("change", (v) => {
      if (v >= 1 && assetRef.current) prevAssetRef.current = null;
    });
    return unsub;
  }, [prevConfig, morphT]);

  // ── Canvas 绘制循环 ──
  useEffect(() => {
    if (!active || !measured) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let dpr = resolveCanvasDpr(window.devicePixelRatio, configRef.current.quality.dprCap);
    let crossfadeA: CrossfadeBuffer | null = null;
    let crossfadeB: CrossfadeBuffer | null = null;

    const reprepareProceduralForTier = (viewportWidth: number): void => {
      const cfg = configRef.current;
      const current = assetRef.current;
      if (current && current.kind === "procedural" && cfg.source.kind === "procedural") {
        assetRef.current = {
          kind: "procedural",
          plume: preparePlume(cfg, viewportWidth),
          surface: current.surface,
        };
      }

      const previousCfg = prevConfigRef.current;
      const previous = prevAssetRef.current;
      if (
        previous &&
        previous.kind === "procedural" &&
        previousCfg &&
        previousCfg.source.kind === "procedural"
      ) {
        prevAssetRef.current = {
          kind: "procedural",
          plume: preparePlume(previousCfg, viewportWidth),
          surface: previous.surface,
        };
      }
    };

    const ensureBuffer = (existing: CrossfadeBuffer | null): CrossfadeBuffer | null => {
      if (existing) {
        if (existing.canvas.width !== canvas.width || existing.canvas.height !== canvas.height) {
          existing.canvas.width = canvas.width;
          existing.canvas.height = canvas.height;
        }
        return existing;
      }

      const buffer = document.createElement("canvas");
      buffer.width = canvas.width;
      buffer.height = canvas.height;
      const bufferCtx = buffer.getContext("2d");
      if (!bufferCtx) return null;

      return { canvas: buffer, ctx: bufferCtx };
    };

    const draw = (): void => {
      raf = 0;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      const m = measurementsRef.current;
      if (!m) {
        ctx.restore();
        return;
      }

      const scroll = scrollY.get();
      const vh = window.innerHeight;
      const raw = Math.min(1, scroll / (vh * 0.85));
      // 延迟 morph：前 40% 滚动保持全屏（元素动画可见），后 60% 完成 hero → brand 收缩
      const morphP = smoothstep(raw, 0.4, 1.0);
      const p = easeInOutCubic(morphP);

      const heroFrame = resolveArtworkHeroFrame(
        configRef.current,
        { x: m.hero.x, y: m.hero.y, w: m.hero.width, h: m.hero.height },
        window.innerWidth
      );

      const dest: DestRect = {
        x: lerp(heroFrame.x, m.brand.x, p),
        y: lerp(heroFrame.y, m.brand.y, p),
        w: lerp(heroFrame.w, m.brand.width, p),
        h: lerp(heroFrame.h, m.brand.height, p),
      };

      const s = reducedRef.current ? 1 : raw;
      const chrome = plumeChrome(s);
      const current = assetRef.current;
      const previous = prevAssetRef.current;
      const morphProgress = clamp01(morphT.get());

      if (!current && !previous) {
        ctx.restore();
        return;
      }

      const renderDirect = (asset: PreparedArtwork): void => {
        ctx.save();
        roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, chrome.radius);
        ctx.clip();
        ctx.globalAlpha = 1;
        drawPreparedArtwork(ctx, asset, s, dest);
        applyFeather(ctx, dest, chrome.feather);
        ctx.restore();
      };

      const renderBuffer = (buffer: CrossfadeBuffer, asset: PreparedArtwork): void => {
        const bufferCtx = buffer.ctx;
        bufferCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bufferCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        bufferCtx.save();
        roundRectPath(bufferCtx, dest.x, dest.y, dest.w, dest.h, chrome.radius);
        bufferCtx.clip();
        bufferCtx.globalAlpha = 1;
        drawPreparedArtwork(bufferCtx, asset, s, dest);
        applyFeather(bufferCtx, dest, chrome.feather);
        bufferCtx.restore();
      };

      const compositeCrossfade = (
        from: PreparedArtwork,
        to: PreparedArtwork,
        t: number
      ): void => {
        crossfadeA = ensureBuffer(crossfadeA);
        crossfadeB = ensureBuffer(crossfadeB);

        if (!crossfadeA || !crossfadeB) {
          renderDirect(to);
          return;
        }

        renderBuffer(crossfadeA, from);
        renderBuffer(crossfadeB, to);

        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.drawImage(crossfadeA.canvas, 0, 0, window.innerWidth, window.innerHeight);
        ctx.globalAlpha = t;
        ctx.drawImage(crossfadeB.canvas, 0, 0, window.innerWidth, window.innerHeight);
        ctx.restore();
      };

      if (current && previous && morphProgress < 1) {
        if (
          current.kind === "procedural" &&
          previous.kind === "procedural" &&
          plumeTopologyCompatible(previous.plume, current.plume)
        ) {
          ctx.save();
          roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, chrome.radius);
          ctx.clip();

          const cover = coverTransform(
            current.plume.sceneW,
            current.plume.sceneH,
            dest.x,
            dest.y,
            dest.w,
            dest.h
          );
          if (cover) {
            ctx.save();
            ctx.translate(dest.x, dest.y);
            ctx.scale(cover.scale, cover.scale);
            ctx.translate(-cover.sx, -cover.sy);
            drawOrbitalPlume(ctx, current.plume, s, {
              from: previous.plume,
              t: morphProgress,
            });
            // 表面纹理 crossfade：from/to 各持一张，按 morph 权重叠加在插值后的星球圆盘内
            if (previous.surface || current.surface) {
              const mc = {
                x:
                  previous.plume.core.x +
                  (current.plume.core.x - previous.plume.core.x) * morphProgress,
                y:
                  previous.plume.core.y +
                  (current.plume.core.y - previous.plume.core.y) * morphProgress,
                r:
                  previous.plume.core.r +
                  (current.plume.core.r - previous.plume.core.r) * morphProgress,
              };
              ctx.save();
              ctx.beginPath();
              ctx.arc(mc.x, mc.y, mc.r, 0, Math.PI * 2);
              ctx.clip();
              drawPlanetSurfaceOverlay(ctx, mc, previous.surface, 1 - morphProgress);
              drawPlanetSurfaceOverlay(ctx, mc, current.surface, morphProgress);
              ctx.restore();
            }
            ctx.restore();
          }

          applyFeather(ctx, dest, chrome.feather);
          ctx.restore();
        } else if (
          current.kind === "vector" &&
          previous.kind === "vector" &&
          previous.topologyId &&
          current.topologyId &&
          previous.topologyId === current.topologyId
        ) {
          ctx.save();
          roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, chrome.radius);
          ctx.clip();
          renderSceneMorph(ctx, previous.scene, current.scene, morphProgress, s, dest);
          applyFeather(ctx, dest, chrome.feather);
          ctx.restore();
        } else {
          compositeCrossfade(previous, current, morphProgress);
        }
      } else if (current) {
        renderDirect(current);
      } else if (previous) {
        renderDirect(previous);
      }

      ctx.restore();
    };

    const scheduleDraw = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(draw);
    };
    scheduleDrawRef.current = scheduleDraw;

    const resize = (): void => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const cfg = configRef.current;
      const nextDpr = resolveCanvasDpr(window.devicePixelRatio, cfg.quality.dprCap);
      const nextTier: DensityTier =
        viewportWidth <= cfg.quality.mobileBreakpoint ? "mobile" : "desktop";

      if (tierRef.current !== null && tierRef.current !== nextTier) {
        reprepareProceduralForTier(viewportWidth);
      }
      tierRef.current = nextTier;
      dpr = nextDpr;

      canvas.width = Math.round(viewportWidth * dpr);
      canvas.height = Math.round(viewportHeight * dpr);
      canvas.style.width = viewportWidth + "px";
      canvas.style.height = viewportHeight + "px";

      scheduleDraw();
    };

    resize();
    window.addEventListener("resize", resize, { passive: true });

    const unsubscribeScroll = scrollY.on("change", scheduleDraw);
    const unsubscribeMorph = morphT.on("change", scheduleDraw);
    scheduleDraw();

    return () => {
      unsubscribeScroll();
      unsubscribeMorph();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      scheduleDrawRef.current = null;
    };
  }, [
    active,
    measured,
    scrollY,
    measurementsRef,
    morphT,
    config.id,
    config.quality.dprCap,
    config.quality.mobileBreakpoint,
  ]);

  // ── zIndex：hero 状态在最底层，header 状态在内容之上 ──
  const zIndex = useTransform(scrollY, (latest: number): number => {
    return latest > vhRef.current * 0.4 ? 6 : 0;
  });

  // ── Canvas 透明度：65% ~ 85% 淡出，与 brand-mark 交叉 ──
  const opacity = useTransform(scrollY, (latest: number): number => {
    const start = vhRef.current * 0.65;
    const end = vhRef.current * 0.85;
    if (latest < start) return 1;
    if (latest > end) return 0;
    return 1 - (latest - start) / (end - start);
  });

  return {
    canvasRef,
    artwork: { zIndex, opacity },
  };
}
