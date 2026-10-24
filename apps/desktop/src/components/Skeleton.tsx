import type { CSSProperties } from "react";

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  lines?: number;
}

export function Skeleton({ width = "100%", height = "1em", lines = 1 }: SkeletonProps) {
  const count = Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 1;
  return <>
    {Array.from({ length: count }, (_, index) => (
      <span key={index} className="skeleton" style={{ width, height }} aria-hidden="true" />
    ))}
  </>;
}
