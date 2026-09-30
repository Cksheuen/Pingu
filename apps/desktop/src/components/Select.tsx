import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";

export interface SelectOption { value: string; label: string; group?: string; detail?: string; disabled?: boolean }
interface Props { id?: string; label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; placeholder?: string; searchable?: boolean }

/** One keyboard-accessible picker for compact filters and large node lists. */
export default function Select({ id, label, value, options, onChange, disabled, placeholder, searchable = false }: Props) {
  const uid = useId();
  const listId = `${uid}-list`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 320, transform: "none" });
  const selected = options.find(o => o.value === value);
  const filtered = options.filter(o => `${o.label} ${o.group ?? ""} ${o.detail ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const show = () => { setQuery(""); setActive(Math.max(0, options.findIndex(o => o.value === value && !o.disabled))); setOpen(true); };
  const choose = (option: SelectOption) => { if (!option.disabled) { onChange(option.value); close(true); } };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, searchable ? 310 : 180), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const useBelow = below >= Math.min(250, above);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: useBelow ? rect.bottom + 5 : rect.top - 5, width, maxHeight: Math.min(340, useBelow ? below : above), transform: useBelow ? "none" : "translateY(-100%)" });
    };
    place();
    (searchable ? search.current : list.current)?.focus();
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) place(); };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", scroll, true); document.removeEventListener("pointerdown", outside); };
  }, [open, searchable, query, options.length]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) document.getElementById(`${uid}-option-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, open, uid]);
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(true); return; }
    if (event.key === "Enter") { event.preventDefault(); if (filtered[active]) choose(filtered[active]); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
    let index = event.key === "Home" ? -1 : event.key === "End" ? filtered.length : active;
    for (let count = 0; count < filtered.length; count++) { index = (index + step + filtered.length) % filtered.length; if (!filtered[index].disabled) { setActive(index); break; } }
  };
  return <>
    <button id={id} ref={trigger} type="button" className="select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={e => { if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); show(); } }}>
      <span className="select-value" title={selected?.label}>{selected?.label ?? placeholder ?? t("chain.choose")}</span><span className="select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(<div ref={popup} className="select-popup" style={position} onKeyDown={keyDown}>
      {searchable && <div className="select-search"><span aria-hidden="true">⌕</span><input ref={search} role="combobox" aria-label={t("select.search")} aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={filtered[active] ? `${uid}-option-${active}` : undefined} placeholder={t("select.search")} value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} /></div>}
      <div ref={list} id={listId} className="select-options" role="listbox" aria-label={label} tabIndex={-1} aria-activedescendant={filtered[active] ? `${uid}-option-${active}` : undefined}>
        {filtered.map((option, index) => <div key={option.value}>
          {option.group && (index === 0 || filtered[index - 1].group !== option.group) && <div className="select-group">{option.group}</div>}
          <div id={`${uid}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} className="select-option" data-active={active === index} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(option)}>
            <span className="select-option-name">{option.label}</span>{option.detail && <small>{option.detail}</small>}<span className="select-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
          </div></div>)}
        {!filtered.length && <div className="select-empty">{t("select.empty")}</div>}
      </div>
    </div>, document.body)}
  </>;
}
