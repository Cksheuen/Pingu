import { useCallback, useEffect, useRef, type RefObject } from "react";

export interface ScrollUi {
  articleRef: RefObject<HTMLElement | null>;
  progressRef: RefObject<HTMLElement | null>;
  backToTopRef: RefObject<HTMLButtonElement | null>;
  scrollToTop: () => void;
}

// 阅读进度条与 back-to-top 按钮的滚动同步（rAF 节流）。
export function useScrollUi(): ScrollUi {
  const articleRef = useRef<HTMLElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const backToTopRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<number | null>(null);

  const syncReadingUi = useCallback(() => {
    const article = articleRef.current;
    const bar = progressRef.current;
    if (article && bar) {
      const rect = article.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      const progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : rect.top <= 0 ? 1 : 0;
      bar.style.transform = `scaleX(${progress})`;
    }
    const button = backToTopRef.current;
    if (button) button.classList.toggle("is-visible", window.scrollY > window.innerHeight);
  }, []);

  useEffect(() => {
    const onScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        syncReadingUi();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [syncReadingUi]);

  // 每次渲染后同步一次阅读进度与 back-to-top 状态。
  useEffect(() => {
    syncReadingUi();
  });

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return { articleRef, progressRef, backToTopRef, scrollToTop };
}
