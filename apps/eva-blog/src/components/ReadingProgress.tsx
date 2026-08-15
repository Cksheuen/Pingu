import type { RefObject } from "react";

interface ReadingProgressProps {
  progressRef: RefObject<HTMLSpanElement | null>;
}

export function ReadingProgress({ progressRef }: ReadingProgressProps) {
  return (
    <div className="reading-progress" aria-hidden="true">
      <span ref={progressRef} />
    </div>
  );
}
