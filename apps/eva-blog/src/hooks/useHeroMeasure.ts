// useHeroMeasure：hero → brand 形变的测量逻辑。
// 负责测量 hero/brand-slot 位置、tab 起止位置、排版计算值，
// 并在字体加载和视口变化时重新测量。

import { useRef, useLayoutEffect, useEffect, useState, type RefObject } from "react";
import { mix } from "framer-motion";
import type { HeroMeasurements, TypographyMeasure, HeroMorphRefs } from "./heroTypes";

// 读取元素的排版计算值（字体加载后测量，避免回退字体造成的偏差）
function measuredTypography(el: Element | null): TypographyMeasure | null {
  if (!el) return null;
  const cs = getComputedStyle(el);
  const letterSpacing = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0;
  const fontSize = parseFloat(cs.fontSize) || 0;
  // lineHeight 返回无单位倍率：framer-motion 对 lineHeight 不追加 px，
  // 传像素值会被当成倍率（20px → 20 倍字号）。"normal" 时用 1.2 近似。
  const lineHeight = cs.lineHeight === "normal" ? 1.2 : parseFloat(cs.lineHeight) / fontSize || 1.2;
  return {
    fontSize,
    letterSpacing,
    paddingTop: parseFloat(cs.paddingTop) || 0,
    paddingBottom: parseFloat(cs.paddingBottom) || 0,
    lineHeight,
  };
}

export interface UseHeroMeasureResult {
  measured: boolean;
  measurementsRef: RefObject<HeroMeasurements | null>;
}

export function useHeroMeasure(active: boolean, refs: HeroMorphRefs, remeasureKey?: string): UseHeroMeasureResult {
  const { heroRef, brandSlotRef, heroTabRefs, navLinkRefs } = refs;
  const measurementsRef = useRef<HeroMeasurements | null>(null);
  const [measured, setMeasured] = useState(false);

  // 统一测量：起点/终点视口位置 + 两端排版计算值
  const measureAll = (): void => {
    const hero = heroRef.current;
    const brandSlot = brandSlotRef.current;
    if (!hero || !brandSlot) return;

    const heroRect = hero.getBoundingClientRect();
    const brandRect = brandSlot.getBoundingClientRect();
    // hero 随页面滚动：用文档相对坐标（加回 scrollY），保证 reload 恢复滚动位置后
    // 测量仍对应 scroll=0 时的视口位置；brand 在 fixed header 中，位置稳定，保持视口相对。
    const heroX = heroRect.left + window.scrollX;
    const heroY = heroRect.top + window.scrollY;
    // brand slot 的内容区（去除 border），与 brand-mark 的 object-fit: cover 对齐
    const brandStyle = getComputedStyle(brandSlot);
    const bl = parseFloat(brandStyle.borderLeftWidth) || 0;
    const bt = parseFloat(brandStyle.borderTopWidth) || 0;
    const br = parseFloat(brandStyle.borderRightWidth) || 0;
    const bb = parseFloat(brandStyle.borderBottomWidth) || 0;

    measurementsRef.current = {
      hero: { x: heroX, y: heroY, width: heroRect.width, height: heroRect.height },
      brand: {
        x: brandRect.left + bl,
        y: brandRect.top + bt,
        width: brandRect.width - bl - br,
        height: brandRect.height - bt - bb,
      },
      tabStarts: (heroTabRefs?.current || []).map((el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      }),
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
    if (!active) return;
    measureAll();
    setMeasured(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, heroRef, brandSlotRef, heroTabRefs, navLinkRefs, remeasureKey]);

  // 字体加载完成后重新测量：自定义字体（Unbounded / Fragment Mono）会改变尺寸和排版值
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (cancelled) return;
      measureAll();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, heroRef, brandSlotRef, heroTabRefs, navLinkRefs, remeasureKey]);

  // 视口尺寸变化后重新测量（响应式断点会改变 hero / nav 布局）
  useEffect(() => {
    if (!active) return;
    const onResize = () => measureAll();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 离开时清除测量缓存
  useEffect(() => {
    if (!active) {
      measurementsRef.current = null;
      setMeasured(false);
    }
  }, [active]);

  return { measured, measurementsRef };
}
