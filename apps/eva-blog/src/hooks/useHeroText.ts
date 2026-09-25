// useHeroText：Hero 文字的连续布局动画。
// 每个元素有独立的连续函数（opacity/yDrift/x/scale/letterSpacing/rotate），
// 文字在整个下滑过程中不断变化布局和效果。
// 滚动对抗：y = -scroll * hold(s) + drift(s)，前 25% 钉在视口，65%+ 跟随滚动。

import { useScroll, useTransform } from "framer-motion";
import { smoothstep, clamp01 } from "../lib/svgRenderer";
import { useViewportHeight } from "./useViewportHeight";
import type { TextAnim, HeroTextMotion } from "./heroTypes";

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

export function useHeroText(active: boolean): HeroTextMotion[] {
  const { scrollY } = useScroll();
  const vhRef = useViewportHeight();

  // 统一进度 s = scroll / (vh * 0.85)，与 Canvas 进度一致
  const textS = (latest: number): number => clamp01(latest / (vhRef.current * 0.85));
  const scrollHold = (s: number): number => 1 - smoothstep(s, 0.25, 0.65);

  return TEXT_ANIM.map((anim) => ({
    opacity: useTransform(scrollY, (latest: number) => (active ? anim.opacity(textS(latest)) : 1)),
    y: useTransform(scrollY, (latest: number) => {
      if (!active) return 0;
      const s = textS(latest);
      return -latest * scrollHold(s) + anim.yDrift(s);
    }),
    x: anim.x
      ? useTransform(scrollY, (latest: number) => (active ? anim.x!(textS(latest)) : 0))
      : undefined,
    scale: anim.scale
      ? useTransform(scrollY, (latest: number) => (active ? anim.scale!(textS(latest)) : 1))
      : undefined,
    letterSpacing: anim.letterSpacing
      ? useTransform(scrollY, (latest: number) =>
          active ? `${anim.letterSpacing!(textS(latest))}em` : "0em"
        )
      : undefined,
    rotate: anim.rotate
      ? useTransform(scrollY, (latest: number) => (active ? anim.rotate!(textS(latest)) : 0))
      : undefined,
  }));
}
