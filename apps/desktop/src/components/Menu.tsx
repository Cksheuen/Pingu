import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: "danger";
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface MenuProps {
  label: string;
  items: MenuItem[];
  trigger?: ReactNode;
}

export function Menu({ label, items, trigger = "⋯" }: MenuProps) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const initial = useRef<"first" | "last">("first");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 320 });
  const close = (restore = false) => {
    setOpen(false);
    if (restore) anchor.current?.focus();
  };
  const show = (edge: "first" | "last" = "first") => {
    initial.current = edge;
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const menu = popup.current;
      if (!rect || !menu) return;
      const below = Math.max(0, window.innerHeight - rect.bottom - 12);
      const above = Math.max(0, rect.top - 12);
      const height = menu.scrollHeight + 2;
      const flip = height > below && above > below;
      const maxHeight = Math.min(360, flip ? above : below);
      setPosition({
        left: Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)),
        top: flip ? rect.top - 4 - Math.min(height, maxHeight) : rect.bottom + 4,
        maxHeight,
      });
    };
    place();
    const enabled = popup.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)");
    const index = initial.current === "last" ? (enabled?.length ?? 1) - 1 : 0;
    (enabled?.[index] ?? popup.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) place();
    };
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>(
      ".menu-item:not(:disabled)",
    ) ?? []);
    if (!enabled.length) return;
    const active = enabled.findIndex(item => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
      : (active + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
    enabled[next].focus();
  };

  return <>
    <button
      ref={anchor}
      type="button"
      className="btn btn-icon btn-ghost"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          show(event.key === "ArrowUp" ? "last" : "first");
        }
      }}
    >
      {trigger}
    </button>
    {open && createPortal(
      <div
        ref={popup}
        id={id}
        className="menu"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={position}
        onKeyDown={keyDown}
      >
        {items.map((item, index) => <div key={index} role="none">
          {item.separatorBefore && <div className="menu-separator" role="separator" />}
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            data-tone={item.tone}
            onClick={() => {
              close(true);
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </div>)}
      </div>,
      document.body,
    )}
  </>;
}
