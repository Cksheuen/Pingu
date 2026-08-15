import { useRef, useLayoutEffect, useEffect, useState, type RefObject } from "react";
import { useScroll, useTransform, useReducedMotion, mix, type MotionValue } from "framer-motion";
import {
  fetchScene,
  renderScene,
  sceneState,
  coverTransform,
  easeOutCubic,
  easeOutExpo,
  easeInOutCubic,
  smoothstep,
  clamp01,
  lerp,
  type Scene,
} from "../lib/svgRenderer";
import { createMathCurves, drawMathCurves, type MathCurves } from "../lib/mathCurves";

// ── 类型 ──────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

interface TypographyMeasure {
  fontSize: number;
  letterSpacing: number;
  paddingTop: number;
  paddingBottom: number;
  lineHeight: number | null;
}

interface RectMeasure {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HeroMeasurements {
  hero: RectMeasure;
  brand: RectMeasure;
  tabStarts: Array<DOMRect | null>;
  tabEnds: Array<DOMRect | null>;
  tabType: Array<TypographyMeasure | null>;
  navType: Array<TypographyMeasure | null>;
  tabColorMix: ((p: number) => string) | null;
}

export interface HeroMorphRefs {
  heroRef: RefObject<HTMLElement | null>;
  brandSlotRef: RefObject<HTMLElement | null>;
  heroTabRefs: RefObject<Array<HTMLElement | null>>;
  navLinkRefs: RefObject<Array<HTMLElement | null>>;
  artworkSrc: string;
}

interface TabFlight {
  x: MotionValue<number>;
  y: MotionValue<number>;
  opacity: MotionValue<number>;
  pointerEvents: MotionValue<string>;
  fontMorph: {
    fontSize: MotionValue<number>;
    letterSpacing: MotionValue<number>;
    paddingTop: MotionValue<number>;
    paddingBottom: MotionValue<number>;
    lineHeight: MotionValue<number>;
    color: MotionValue<string>;
  };
}

interface TextAnim {
  opacity: (s: number) => number;
  yDrift: (s: number) => number;
  x?: (s: number) => number;
  scale?: (s: number) => number;
  letterSpacing?: (s: number) => number;
  rotate?: (s: number) => number;
}

export interface HeroTextMotion {
  opacity: MotionValue<number>;
  y: MotionValue<number>;
  x?: MotionValue<number>;
  scale?: MotionValue<number>;
  letterSpacing?: MotionValue<string>;
  rotate?: MotionValue<number>;
}

export interface HeroMorphResult {
  measured: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  artwork: { zIndex: MotionValue<number>; opacity: MotionValue<number> };
  header: { opacity: MotionValue<number>; pointerEvents: MotionValue<string> };
  heroTextItems: HeroTextMotion[];
  tabs: TabFlight[];
}

// ── 路径与缓动函数 ──────────────────────────────────────────

// 二次贝塞尔：t ∈ [0,1]，给定起点 P0、终点 P3、弧高系数，返回路径上的点
function quadraticBezier(p0: Point, p3: Point, arcFactor: number, t: number): Point {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy) || 1;
  // 垂直于 P0→P3 的法向量
  const nx = -dy / dist;
  const ny = dx / dist;
  const mid = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
  const c = { x: mid.x + nx * arcFactor * dist, y: mid.y + ny * arcFactor * dist };
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p3.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p3.y,
  };
}

// 手动圆角矩形路径（兼容不支持 ctx.roundRect 的浏览器）
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// object-fit: cover 等价绘制（矢量场景不可用时的位图兜底）
function coverDraw(ctx: CanvasRenderingContext2D, img: HTMLImageElement | HTMLCanvasElement, dx: number, dy: number, dw: number, dh: number): void {
  // canvas 没有 naturalWidth，回退到 width/height（与原 JS 运行时行为一致）
  const imgW = ("naturalWidth" in img ? img.naturalWidth : 0) || img.width;
  const imgH = ("naturalHeight" in img ? img.naturalHeight : 0) || img.height;
  if (!imgW || !imgH) return;
  const imgRatio = imgW / imgH;
  const rectRatio = dw / dh;
  let sw: number, sh: number, sx: number, sy: number;
  if (imgRatio > rectRatio) {
    sh = imgH;
    sw = sh * rectRatio;
    sx = (imgW - sw) / 2;
    sy = 0;
  } else {
    sw = imgW;
    sh = sw / rectRatio;
    sx = 0;
    sy = (imgH - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

// 读取元素的排版计算值（字体加载后测量，避免回退字体造成的偏差）
function measuredTypography(el: Element | null): TypographyMeasure | null {
  if (!el) return null;
  const cs = getComputedStyle(el);
  const letterSpacing = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0;
  const lineHeight = cs.lineHeight === "normal" ? null : parseFloat(cs.lineHeight);
  return {
    fontSize: parseFloat(cs.fontSize) || 0,
    letterSpacing,
    paddingTop: parseFloat(cs.paddingTop) || 0,
    paddingBottom: parseFloat(cs.paddingBottom) || 0,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
  };
}

// ── 单个 tab 的飞行动画 + 排版形变 ─────────────────────────

function useTabFlight(scrollY: MotionValue<number>, measurementsRef: RefObject<HeroMeasurements | null>, index: number, arcFactor: number): TabFlight {
  // 飞行进度：25% ~ 65% 视口高度映射到 0% ~ 100%
  const flightRaw = (latest: number): number => {
    const start = window.innerHeight * 0.25;
    const end = window.innerHeight * 0.65;
    return Math.min(1, Math.max(0, (latest - start) / (end - start)));
  };

  const flightP = useTransform(scrollY, (latest: number) => easeOutExpo(flightRaw(latest)));

  const x = useTransform(flightP, (p: number) => {
    const m = measurementsRef.current;
    if (!m?.tabStarts?.[index] || !m?.tabEnds?.[index]) return 0;
    return quadraticBezier(m.tabStarts[index] as DOMRect, m.tabEnds[index] as DOMRect, arcFactor, p).x;
  });

  const y = useTransform([scrollY, flightP], ([latest, p]: number[]) => {
    const m = measurementsRef.current;
    if (!m?.tabStarts?.[index] || !m?.tabEnds?.[index]) return 0;
    const pos = quadraticBezier(m.tabStarts[index] as DOMRect, m.tabEnds[index] as DOMRect, arcFactor, p);
    // 起飞前跟随滚动，起飞后逐渐固定到 header
    return pos.y - latest * (1 - p);
  });

  const opacity = useTransform(scrollY, (latest: number) => {
    const fadeStart = window.innerHeight * 0.70;
    const fadeEnd = window.innerHeight * 0.78;
    if (latest < fadeStart) return 1;
    if (latest > fadeEnd) return 0;
    return 1 - (latest - fadeStart) / (fadeEnd - fadeStart);
  });

  // 飞行中可点击，淡出后禁用
  const pointerEvents = useTransform(scrollY, (latest: number): string => {
    return latest > window.innerHeight * 0.78 ? "none" : "auto";
  });

  // ── 排版形变：统一 Fragment Mono，字号/字距/内边距/颜色连续插值 ──
  const typeFrom = (key: "fontSize" | "letterSpacing" | "paddingTop" | "paddingBottom") => (p: number): number => {
    const m = measurementsRef.current;
    const a = m?.tabType?.[index];
    const b = m?.navType?.[index];
    if (!a || !b) return 0;
    return lerp(a[key], b[key], easeInOutCubic(p));
  };

  const fontSize = useTransform(flightP, typeFrom("fontSize"));
  const letterSpacing = useTransform(flightP, typeFrom("letterSpacing"));
  const paddingTop = useTransform(flightP, typeFrom("paddingTop"));
  const paddingBottom = useTransform(flightP, typeFrom("paddingBottom"));
  const lineHeight = useTransform(flightP, (p: number): number => {
    const m = measurementsRef.current;
    const a = m?.tabType?.[index];
    const b = m?.navType?.[index];
    if (!a?.lineHeight || !b?.lineHeight) return 0;
    return lerp(a.lineHeight, b.lineHeight, easeInOutCubic(p));
  }) as MotionValue<number>;

  // 颜色：--ink → --on-dark-soft（hero 亮底 → header 暗底）
  const color = useTransform(flightP, (p: number): string => {
    const m = measurementsRef.current;
    if (!m?.tabColorMix) return "";
    return m.tabColorMix(easeInOutCubic(p));
  });

  return {
    x,
    y,
    opacity,
    pointerEvents,
    fontMorph: {
      fontSize,
      letterSpacing,
      paddingTop,
      paddingBottom,
      lineHeight,
      color,
    },
  };
}

// ── 主 hook ────────────────────────────────────────────────

export function useHeroMorph(isHome: boolean, refs: HeroMorphRefs): HeroMorphResult {
  const { heroRef, brandSlotRef, heroTabRefs, navLinkRefs, artworkSrc } = refs;
  const { scrollY } = useScroll();
  const measurementsRef = useRef<HeroMeasurements | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [measured, setMeasured] = useState(false);
  const reducedMotion = useReducedMotion();
  const reducedRef = useRef<boolean | null>(reducedMotion);
  reducedRef.current = reducedMotion;

  // 统一测量：起点/终点视口位置 + 两端排版计算值
  const measureAll = (): void => {
    const hero = heroRef.current;
    const brandSlot = brandSlotRef.current;
    if (!hero || !brandSlot) return;

    const heroRect = hero.getBoundingClientRect();
    const brandRect = brandSlot.getBoundingClientRect();
    // brand slot 的内容区（去除 border），与 brand-mark 的 object-fit: cover 对齐
    const brandStyle = getComputedStyle(brandSlot);
    const bl = parseFloat(brandStyle.borderLeftWidth) || 0;
    const bt = parseFloat(brandStyle.borderTopWidth) || 0;
    const br = parseFloat(brandStyle.borderRightWidth) || 0;
    const bb = parseFloat(brandStyle.borderBottomWidth) || 0;

    measurementsRef.current = {
      hero: { x: heroRect.left, y: heroRect.top, width: heroRect.width, height: heroRect.height },
      brand: {
        x: brandRect.left + bl,
        y: brandRect.top + bt,
        width: brandRect.width - bl - br,
        height: brandRect.height - bt - bb,
      },
      tabStarts: (heroTabRefs?.current || []).map((el) => (el ? el.getBoundingClientRect() : null)),
      tabEnds: (navLinkRefs?.current || []).map((el) => (el ? el.getBoundingClientRect() : null)),
      tabType: (heroTabRefs?.current || []).map((el) => measuredTypography(el)),
      navType: (navLinkRefs?.current || []).map((el) => measuredTypography(el)),
      tabColorMix: (() => {
        const tabEl = heroTabRefs?.current?.[0];
        const navEl = navLinkRefs?.current?.[0];
        if (!tabEl || !navEl) return null;
        return mix(getComputedStyle(tabEl).color, getComputedStyle(navEl).color);
      })(),
    };
  };

  // 在 DOM 挂载后、任何滚动前测量
  useLayoutEffect(() => {
    if (!isHome) return;
    measureAll();
    setMeasured(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHome, heroRef, brandSlotRef, heroTabRefs, navLinkRefs]);

  // 字体加载完成后重新测量：自定义字体（Unbounded / Fragment Mono）会改变尺寸和排版值
  useEffect(() => {
    if (!isHome) return;
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (cancelled) return;
      measureAll();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHome, heroRef, brandSlotRef, heroTabRefs, navLinkRefs]);

  // 视口尺寸变化后重新测量（响应式断点会改变 hero / nav 布局）
  useEffect(() => {
    if (!isHome) return;
    const onResize = () => measureAll();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHome]);

  // 离开首页时清除测量缓存
  useEffect(() => {
    if (!isHome) {
      measurementsRef.current = null;
      setMeasured(false);
    }
  }, [isHome]);

  // ── Canvas 绘制 artwork：矢量场景优先，位图 chroma-key 兜底 ──
  useEffect(() => {
    if (!isHome || !artworkSrc || !measured) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    let scene: Scene | null = null;
    let processedImg: HTMLCanvasElement | HTMLImageElement | null = null;
    let cancelled = false;
    let raf = 0;
    const curves: MathCurves = createMathCurves();

    const draw = (): void => {
      raf = 0;
      const m = measurementsRef.current;
      if (!m) return;

      const scroll = scrollY.get();
      const vh = window.innerHeight;
      const raw = Math.min(1, scroll / (vh * 0.85));
      const p = easeOutCubic(raw);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      // 插值矩形：hero → brand（内容区）
      const dest = {
        x: lerp(m.hero.x, m.brand.x, p),
        y: lerp(m.hero.y, m.brand.y, p) - scroll * (1 - p),
        w: lerp(m.hero.width, m.brand.width, p),
        h: lerp(m.hero.height, m.brand.height, p),
      };

      // 场景状态：逐元素滚动动画（减弱动态效果时直接呈现终态）
      // scene 可能尚未加载完成，保持原 JS 行为：直接透传给 sceneState
      const state = sceneState(scene as Scene, reducedRef.current ? 1 : raw);

      // 圆角裁剪（终态 2px，与 brand-mark 一致）
      roundRectPath(ctx, dest.x, dest.y, dest.w, dest.h, state.radius);
      ctx.clip();

      if (scene) {
        renderScene(ctx, scene, state, dest);
        // 数学曲线：与场景共享 cover 变换和圆角裁剪，在 renderScene 之后绘制
        const cover = coverTransform(scene.width, scene.height, dest.x, dest.y, dest.w, dest.h);
        if (cover) {
          ctx.save();
          ctx.translate(dest.x, dest.y);
          ctx.scale(cover.scale, cover.scale);
          ctx.translate(-cover.sx, -cover.sy);
          drawMathCurves(ctx, curves, reducedRef.current ? 1 : raw);
          ctx.restore();
        }
      } else if (processedImg) {
        coverDraw(ctx, processedImg, dest.x, dest.y, dest.w, dest.h);
      }

      // 软边羽化：用 destination-out 渐变擦除边缘（终态收敛到 0）
      const feather = state.feather;
      if (feather > 0.5) {
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
      }

      ctx.restore();
    };

    const scheduleDraw = (): void => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const resize = (): void => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      scheduleDraw();
    };
    resize();
    window.addEventListener("resize", resize);

    // 矢量场景：解析 SVG 并逐元素绘制（无光栅化损失）
    fetchScene(artworkSrc)
      .then((s) => {
        if (cancelled) return;
        scene = s;
        scheduleDraw();
      })
      .catch(() => {
        if (cancelled) return;
        loadRasterFallback();
      });

    // 位图兜底：chroma key 抠除渐变背景（SVG 解析失败或 artworkSrc 为位图时）
    const loadRasterFallback = (): void => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const offscreen = document.createElement("canvas");
        offscreen.width = img.naturalWidth;
        offscreen.height = img.naturalHeight;
        const offCtx = offscreen.getContext("2d");
        if (!offCtx) return;
        offCtx.drawImage(img, 0, 0);

        const imageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
        const data = imageData.data;
        const w = offscreen.width;
        const h = offscreen.height;

        const idx = (x: number, y: number): number => (y * w + x) * 4;
        const tl = { r: data[idx(0, 0)], g: data[idx(0, 0) + 1], b: data[idx(0, 0) + 2] };
        const tr = { r: data[idx(w - 1, 0)], g: data[idx(w - 1, 0) + 1], b: data[idx(w - 1, 0) + 2] };
        const bl = { r: data[idx(0, h - 1)], g: data[idx(0, h - 1) + 1], b: data[idx(0, h - 1) + 2] };
        const br = { r: data[idx(w - 1, h - 1)], g: data[idx(w - 1, h - 1) + 1], b: data[idx(w - 1, h - 1) + 2] };

        const threshold = 28;
        for (let y = 0; y < h; y++) {
          const fy = y / (h - 1);
          for (let x = 0; x < w; x++) {
            const fx = x / (w - 1);
            const i = idx(x, y);
            const bgR = tl.r + (tr.r - tl.r) * fx + (bl.r - tl.r) * fy;
            const bgG = tl.g + (tr.g - tl.g) * fx + (bl.g - tl.g) * fy;
            const bgB = tl.b + (tr.b - tl.b) * fx + (bl.b - tl.b) * fy;
            const dist = Math.sqrt(
              (data[i] - bgR) ** 2 + (data[i + 1] - bgG) ** 2 + (data[i + 2] - bgB) ** 2
            );
            if (dist < threshold) {
              data[i + 3] = 0;
            } else if (dist < threshold * 2) {
              const alpha = (dist - threshold) / threshold;
              data[i + 3] = Math.min(data[i + 3], alpha * 255);
            }
          }
        }
        offCtx.putImageData(imageData, 0, 0);
        processedImg = offscreen;
        scheduleDraw();
      };
      img.onerror = () => {
        processedImg = img;
        scheduleDraw();
      };
      img.src = artworkSrc;
    };

    const unsubscribe = scrollY.on("change", scheduleDraw);
    scheduleDraw();

    return () => {
      cancelled = true;
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [isHome, artworkSrc, measured, scrollY, measurementsRef]);

  // ── zIndex：hero 状态在最底层，header 状态在内容之上 ──

  const artworkZIndex = useTransform(scrollY, (latest: number): number => {
    return latest > window.innerHeight * 0.4 ? 6 : 0;
  });

  // ── Canvas 透明度：65% ~ 85% 淡出，与 brand-mark 交叉 ──

  const canvasOpacity = useTransform(scrollY, (latest: number): number => {
    const start = window.innerHeight * 0.65;
    const end = window.innerHeight * 0.85;
    if (latest < start) return 1;
    if (latest > end) return 0;
    return 1 - (latest - start) / (end - start);
  });

  // ── Header：65% ~ 85% 视口高度淡入 ─────────────────────

  const headerOpacity = useTransform(scrollY, (latest: number): number => {
    const start = window.innerHeight * 0.65;
    const end = window.innerHeight * 0.85;
    if (latest < start) return 0;
    if (latest > end) return 1;
    return (latest - start) / (end - start);
  });

  const headerPointerEvents = useTransform(scrollY, (latest: number): string => {
    return latest >= window.innerHeight * 0.65 ? "auto" : "none";
  });

  // ── Hero text：连续布局变化（非离散淡出）─────────────────
  // 统一进度 s = scroll / (vh * 0.85)，与 Canvas 进度一致。
  // 每个元素有独立的连续函数，文字在整个下滑过程中不断变化布局和效果。
  // 滚动对抗：y = -scroll * hold(s) + drift(s)，前 25% 钉在视口，65%+ 跟随滚动。
  const textS = (latest: number): number => clamp01(latest / (window.innerHeight * 0.85));
  const scrollHold = (s: number): number => 1 - smoothstep(s, 0.25, 0.65);

  // 每个元素的连续动画函数（所有函数在 s=0 时返回自然值，s=1 时 drift 归零）
  const TEXT_ANIM: TextAnim[] = [
    // eyebrow：字距扩散 + 微旋 + 右移
    {
      opacity: (s) => 1 - smoothstep(s, 0.3, 0.6),
      yDrift: (s) => -30 * Math.sin(s * Math.PI),
      x: (s) => 20 * smoothstep(s, 0.1, 0.4),
      letterSpacing: (s) => 0.09 + 0.22 * smoothstep(s, 0.05, 0.5),
      rotate: (s) => -1.5 * smoothstep(s, 0.1, 0.5),
    },
    // h1 第一行：字号微缩 + 字距微扩
    {
      opacity: (s) => 1 - smoothstep(s, 0.3, 0.6),
      yDrift: (s) => -40 * Math.sin(s * Math.PI),
      scale: (s) => 1 - 0.05 * smoothstep(s, 0.1, 0.5),
      letterSpacing: (s) => 0.02 * smoothstep(s, 0.1, 0.5),
    },
    // h1 第二行（em）：右移错位 + 字号微缩
    {
      opacity: (s) => 1 - smoothstep(s, 0.3, 0.6),
      yDrift: (s) => -35 * Math.sin(s * Math.PI),
      x: (s) => 32 * smoothstep(s, 0.1, 0.5),
      scale: (s) => 1 - 0.05 * smoothstep(s, 0.1, 0.5),
    },
    // intro：左移 + 字距微扩
    {
      opacity: (s) => 1 - smoothstep(s, 0.3, 0.6),
      yDrift: (s) => -25 * Math.sin(s * Math.PI),
      x: (s) => -16 * smoothstep(s, 0.1, 0.4),
      letterSpacing: (s) => 0.01 + 0.04 * smoothstep(s, 0.1, 0.5),
    },
    // actions：右移 + 微旋
    {
      opacity: (s) => 1 - smoothstep(s, 0.3, 0.6),
      yDrift: (s) => -20 * Math.sin(s * Math.PI),
      x: (s) => 24 * smoothstep(s, 0.1, 0.4),
      rotate: (s) => -1.5 * smoothstep(s, 0.1, 0.5),
    },
  ];

  const heroTextItems: HeroTextMotion[] = TEXT_ANIM.map((anim) => ({
    opacity: useTransform(scrollY, (latest: number) => anim.opacity(textS(latest))),
    y: useTransform(scrollY, (latest: number) => {
      const s = textS(latest);
      return -latest * scrollHold(s) + anim.yDrift(s);
    }),
    x: anim.x ? useTransform(scrollY, (latest: number) => anim.x!(textS(latest))) : undefined,
    scale: anim.scale ? useTransform(scrollY, (latest: number) => anim.scale!(textS(latest))) : undefined,
    letterSpacing: anim.letterSpacing
      ? useTransform(scrollY, (latest: number) => `${anim.letterSpacing!(textS(latest))}em`)
      : undefined,
    rotate: anim.rotate ? useTransform(scrollY, (latest: number) => anim.rotate!(textS(latest))) : undefined,
  }));

  // ── Flying tabs（4 个，贝塞尔弧线飞行，飞行中可点击，排版渐变为 nav 样式）──

  const tab0 = useTabFlight(scrollY, measurementsRef, 0, 0.15);
  const tab1 = useTabFlight(scrollY, measurementsRef, 1, 0.3);
  const tab2 = useTabFlight(scrollY, measurementsRef, 2, 0.45);
  const tab3 = useTabFlight(scrollY, measurementsRef, 3, 0.6);
  const tabs = [tab0, tab1, tab2, tab3];

  // ── 8 秒超时自动滚动 ────────────────────────────────────

  useEffect(() => {
    if (!isHome) return;
    let autoScrolling = false;
    const timer = setTimeout(() => {
      autoScrolling = true;
      window.scrollTo({ top: window.innerHeight, behavior: "smooth" });
    }, 8000);
    const cancel = () => {
      if (!autoScrolling) clearTimeout(timer);
    };
    window.addEventListener("scroll", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { once: true, passive: true });
    window.addEventListener("keydown", cancel, { once: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [isHome]);

  return {
    measured,
    canvasRef,
    artwork: { zIndex: artworkZIndex, opacity: canvasOpacity },
    header: {
      opacity: headerOpacity,
      pointerEvents: headerPointerEvents,
    },
    heroTextItems,
    tabs,
  };
}
