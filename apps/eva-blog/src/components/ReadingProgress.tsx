import type { RefObject } from "react";

export interface ReadingProgressProps {
  // 与 useScrollUi 的 ScrollUi.progressRef 对齐（HTMLSpanElement 是空接口，HTMLElement 可直接赋给 span 的 ref）
  progressRef: RefObject<HTMLElement | null>;
}

export function ReadingProgress({ progressRef }: ReadingProgressProps) {
  return (
    <div className="reading-progress" aria-hidden="true">
      <span ref={progressRef} />
    </div>
  );
}
