// ArtworkCanvas：可复用的 Canvas 背景组件。
// 包装 useArtworkCanvas，渲染 motion.canvas。
// 支持路由切换时的 liquid morph。

import type { RefObject } from "react";
import { motion, type MotionValue } from "framer-motion";
import { useArtworkCanvas } from "../hooks/useArtworkCanvas";
import type { ArtworkConfig } from "../lib/artworkConfig";
import type { HeroMeasurements } from "../hooks/heroTypes";

export interface ArtworkCanvasProps {
  active: boolean;
  measured: boolean;
  measurementsRef: RefObject<HeroMeasurements | null>;
  config: ArtworkConfig;
  prevConfig: ArtworkConfig | null;
  morphT: MotionValue<number>;
}

export function ArtworkCanvas({ active, measured, measurementsRef, config, prevConfig, morphT }: ArtworkCanvasProps) {
  const { canvasRef, artwork } = useArtworkCanvas({
    active,
    measured,
    measurementsRef,
    config,
    prevConfig,
    morphT,
  });

  if (!active || !measured) return null;

  return (
    <motion.canvas
      ref={canvasRef}
      className="artwork-canvas"
      style={{ zIndex: artwork.zIndex, opacity: artwork.opacity }}
    />
  );
}
