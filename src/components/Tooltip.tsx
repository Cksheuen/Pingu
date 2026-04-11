import { useState, useRef } from "react";
import { createPortal } from "react-dom";

interface TooltipPos {
  x: number;
  y: number;
  flipped: boolean;
}

export default function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<TooltipPos>({ x: 0, y: 0, flipped: false });
  const ref = useRef<HTMLSpanElement>(null);

  if (!text) return null;

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipWidth = 260;
      const tooltipHeight = 80; // approximate max height
      const gap = 8;

      // Determine whether to flip below (if not enough room above)
      const wouldClipTop = rect.top - tooltipHeight - gap < 0;

      // Clamp horizontal position to keep tooltip within viewport
      let x = rect.left + rect.width / 2;
      if (x - tooltipWidth / 2 < 8) x = tooltipWidth / 2 + 8;
      if (x + tooltipWidth / 2 > window.innerWidth - 8)
        x = window.innerWidth - tooltipWidth / 2 - 8;

      setPos({
        x,
        y: wouldClipTop ? rect.bottom : rect.top,
        flipped: wouldClipTop,
      });
    }
    setShow(true);
  };

  return (
    <>
      <span
        ref={ref}
        className="inline-flex items-center ml-1.5"
        onMouseEnter={handleEnter}
        onMouseLeave={() => setShow(false)}
      >
        <span
          className="inline-flex items-center justify-center w-[15px] h-[15px] rounded-full cursor-help select-none"
          style={{
            border: "1px solid #475569",
            color: "#475569",
            fontSize: "9px",
            fontFamily: "Inter",
            lineHeight: 1,
          }}
        >
          ?
        </span>
      </span>

      {show &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y,
              transform: pos.flipped
                ? "translate(-50%, 0) translateY(8px)"
                : "translate(-50%, -100%) translateY(-8px)",
              backgroundColor: "#1E293B",
              border: "1px solid #334155",
              color: "#CBD5E1",
              fontFamily: "Inter",
              fontSize: "12px",
              lineHeight: "1.5",
              width: "260px",
              whiteSpace: "normal",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              padding: "8px 12px",
              borderRadius: "8px",
              zIndex: 9999,
              pointerEvents: "none",
            }}
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
