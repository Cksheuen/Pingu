// useFlyingTabs：4 个 hero tab 的贝塞尔弧线飞行动画。
// 每个 tab 从 hero 位置沿二次贝塞尔曲线飞到 header nav 位置，
// 飞行中字号/字距/内边距/颜色连续插值为 nav 样式。

import { useRef, type RefObject } from "react";
import { useScroll, useTransform, useReducedMotion, mix, type MotionValue } from "framer-motion";
import { easeOutExpo, easeInOutCubic, lerp } from "../lib/svgRenderer";
import { useViewportHeight } from "./useViewportHeight";
import type { HeroMeasurements, TabFlight, Point } from "./heroTypes";

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

// 单个 tab 的飞行动画 + 排版形变
function useTabFlight(
  scrollY: MotionValue<number>,
  measurementsRef: RefObject<HeroMeasurements | null>,
  index: number,
  arcFactor: number,
  active: boolean,
  vhRef: RefObject<number>
): TabFlight {
  // 飞行进度：25% ~ 65% 视口高度映射到 0% ~ 100%
  const flightRaw = (latest: number): number => {
    const start = vhRef.current * 0.25;
    const end = vhRef.current * 0.65;
    return Math.min(1, Math.max(0, (latest - start) / (end - start)));
  };

  const flightP = useTransform(scrollY, (latest: number) =>
    active ? easeOutExpo(flightRaw(latest)) : 1
  );

  const x = useTransform(flightP, (p: number) => {
    if (!active) return 0;
    const m = measurementsRef.current;
    if (!m?.tabStarts?.[index] || !m?.tabEnds?.[index]) return 0;
    return quadraticBezier(m.tabStarts[index] as DOMRect, m.tabEnds[index] as DOMRect, arcFactor, p).x;
  });

  const y = useTransform([scrollY, flightP], ([latest, p]: number[]) => {
    if (!active) return 0;
    const m = measurementsRef.current;
    if (!m?.tabStarts?.[index] || !m?.tabEnds?.[index]) return 0;
    const pos = quadraticBezier(m.tabStarts[index] as DOMRect, m.tabEnds[index] as DOMRect, arcFactor, p);
    // 起飞前跟随滚动，起飞后逐渐固定到 header
    return pos.y - latest * (1 - p);
  });

  // tab 始终保持可见：飞到 header 后与 nav link 同位置同样式，视觉上是同一个元素
  const opacity = useTransform(scrollY, (): number => (active ? 1 : 0));

  // 飞行中可点击，淡出后禁用
  const pointerEvents = useTransform(scrollY, (latest: number): string => {
    if (!active) return "none";
    return latest > vhRef.current * 0.78 ? "none" : "auto";
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
    if (!a || !b) return 0;
    return lerp(a.lineHeight, b.lineHeight, easeInOutCubic(p));
  }) as MotionValue<number>;

  // 颜色：--ink → --on-dark-soft（hero 亮底 → header 暗底）
  // 延迟到 header 暗底出现时才变色（65%-85% vh），避免飞行中在浅色背景上提前变浅
  const color = useTransform(scrollY, (latest: number): string => {
    if (!active) return "";
    const m = measurementsRef.current;
    if (!m?.tabColorMix) return "";
    const start = vhRef.current * 0.65;
    const end = vhRef.current * 0.85;
    const p = Math.min(1, Math.max(0, (latest - start) / (end - start)));
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

export function useFlyingTabs(
  active: boolean,
  measurementsRef: RefObject<HeroMeasurements | null>
): TabFlight[] {
  const { scrollY } = useScroll();
  const reducedMotion = useReducedMotion();
  const reducedRef = useRef<boolean | null>(reducedMotion);
  reducedRef.current = reducedMotion;
  const vhRef = useViewportHeight();

  const tab0 = useTabFlight(scrollY, measurementsRef, 0, 0.15, active, vhRef);
  const tab1 = useTabFlight(scrollY, measurementsRef, 1, 0.3, active, vhRef);
  const tab2 = useTabFlight(scrollY, measurementsRef, 2, 0.45, active, vhRef);
  const tab3 = useTabFlight(scrollY, measurementsRef, 3, 0.6, active, vhRef);

  return [tab0, tab1, tab2, tab3];
}
