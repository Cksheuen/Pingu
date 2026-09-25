// useRouteArtworkMorph：路由切换时驱动 morphT 从 0→1（routeMorphDurationMs, easeInOutCubic）。
// 跟踪 config 变化，维护 prevConfig 供 morph 渲染使用。

import { useEffect, useRef, useState } from "react";
import { useMotionValue, animate, useReducedMotion } from "framer-motion";
import { easeInOutCubic } from "../lib/svgRenderer";
import type { ArtworkConfig } from "../lib/artworkConfig";
import type { MotionValue } from "framer-motion";

export interface UseRouteArtworkMorphResult {
  morphT: MotionValue<number>;
  prevConfig: ArtworkConfig | null;
}

export function useRouteArtworkMorph(config: ArtworkConfig): UseRouteArtworkMorphResult {
  const morphT = useMotionValue(1);
  const reducedMotion = useReducedMotion();
  const prevConfigRef = useRef<ArtworkConfig | null>(null);
  const [prevConfig, setPrevConfig] = useState<ArtworkConfig | null>(null);

  useEffect(() => {
    const prev = prevConfigRef.current;
    prevConfigRef.current = config;

    if (reducedMotion) {
      setPrevConfig(null);
      morphT.set(1);
      return;
    }

    if (prev && prev.id !== config.id) {
      setPrevConfig(prev);
      morphT.set(0);
      const controls = animate(morphT, 1, {
        duration: config.motion.routeMorphDurationMs / 1000,
        ease: easeInOutCubic,
      });
      return () => controls.stop();
    }
  }, [config, reducedMotion, morphT]);

  // morph 完成后清理 prevConfig；初始值已为 1 时也立即清理。
  useEffect(() => {
    if (morphT.get() >= 1) setPrevConfig(null);
    const unsub = morphT.on("change", (v) => {
      if (v >= 1) {
        setPrevConfig(null);
      }
    });
    return unsub;
  }, [morphT]);

  return { morphT, prevConfig };
}
