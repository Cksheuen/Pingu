// useHeaderScroll：Header 随滚动淡入/淡出 + pointerEvents 切换。
// 65%~85% 视口高度为过渡区间。

import { useScroll, useTransform } from "framer-motion";
import { useViewportHeight } from "./useViewportHeight";
import type { HeaderMotion } from "./heroTypes";

export function useHeaderScroll(active: boolean): HeaderMotion {
  const { scrollY } = useScroll();
  const vhRef = useViewportHeight();

  const opacity = useTransform(scrollY, (latest: number): number => {
    if (!active) return 1;
    const start = vhRef.current * 0.65;
    const end = vhRef.current * 0.85;
    if (latest < start) return 0;
    if (latest > end) return 1;
    return (latest - start) / (end - start);
  });

  const pointerEvents = useTransform(scrollY, (latest: number): string => {
    if (!active) return "auto";
    return latest >= vhRef.current * 0.65 ? "auto" : "none";
  });

  return { opacity, pointerEvents };
}
