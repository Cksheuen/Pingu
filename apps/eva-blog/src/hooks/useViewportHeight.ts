// useViewportHeight：缓存 viewport 高度，避免在 useTransform 回调中
// 每帧读取 window.innerHeight 触发强制同步布局（forced synchronous layout）。
// resize 时自动更新。

import { useEffect, useRef } from "react";

export function useViewportHeight() {
  const vhRef = useRef(window.innerHeight);
  useEffect(() => {
    const onResize = () => { vhRef.current = window.innerHeight; };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vhRef;
}
