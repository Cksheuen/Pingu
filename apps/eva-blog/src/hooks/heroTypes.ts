// Hero morph 共享类型：从 useHeroMorph 拆分，供多个 hook 和组件复用。

import type { RefObject } from "react";
import type { MotionValue } from "framer-motion";

// ── 测量类型 ─────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface TypographyMeasure {
  fontSize: number;
  letterSpacing: number;
  paddingTop: number;
  paddingBottom: number;
  lineHeight: number;
}

export interface RectMeasure {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeroMeasurements {
  hero: RectMeasure;
  brand: RectMeasure;
  tabStarts: Array<DOMRect | null>;
  tabEnds: Array<DOMRect | null>;
  tabType: Array<TypographyMeasure | null>;
  navType: Array<TypographyMeasure | null>;
  tabColorMix: ((p: number) => string) | null;
}

// ── Refs ─────────────────────────────────────────────────

export interface HeroMorphRefs {
  heroRef: RefObject<HTMLElement | null>;
  brandSlotRef: RefObject<HTMLElement | null>;
  heroTabRefs: RefObject<Array<HTMLElement | null>>;
  navLinkRefs: RefObject<Array<HTMLElement | null>>;
}

// ── Tab 飞行 ─────────────────────────────────────────────

export interface TabFlight {
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

// ── Hero 文字动画 ────────────────────────────────────────

export interface TextAnim {
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

// ── Hook 返回类型 ────────────────────────────────────────

export interface ArtworkMotion {
  zIndex: MotionValue<number>;
  opacity: MotionValue<number>;
}

export interface HeaderMotion {
  opacity: MotionValue<number>;
  pointerEvents: MotionValue<string>;
}

// ── 视图共享的 Hero props ────────────────────────────────

export interface HeroProps {
  heroRef: RefObject<HTMLElement | null>;
  heroTabRefs: RefObject<(HTMLAnchorElement | null)[]>;
  heroTextItems: HeroTextMotion[];
}
