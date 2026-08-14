import { useCallback, useEffect, useRef, useState } from "react";

// 移植自 main.js 的 syncIntroDock（首页 condensed 阈值）与 syncReadingUi。
export function useScrollUi(isHome) {
  const [condensed, setCondensedState] = useState(false);
  const articleRef = useRef(null);
  const progressRef = useRef(null);
  const backToTopRef = useRef(null);
  const frameRef = useRef(null);
  const condensedRef = useRef(false);
  const isHomeRef = useRef(isHome);
  isHomeRef.current = isHome;

  const setCondensed = useCallback((value) => {
    condensedRef.current = value;
    setCondensedState(value);
  }, []);

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
        const home = isHomeRef.current;
        const shouldCondense = home && (condensedRef.current ? window.scrollY > 42 : window.scrollY > 150);
        if (shouldCondense !== condensedRef.current) {
          condensedRef.current = shouldCondense;
          setCondensedState(shouldCondense);
        }
        syncReadingUi();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [syncReadingUi]);

  // 与旧版一致：每次渲染后同步一次阅读进度与 back-to-top 状态。
  useEffect(() => {
    syncReadingUi();
  });

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return { condensed, setCondensed, articleRef, progressRef, backToTopRef, scrollToTop };
}
