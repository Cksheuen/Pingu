import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { resolveShortcut } from "../lib/shortcuts";
import { useHomeConnection } from "./useHomeConnection";

export function useShortcuts() {
  const navigate = useNavigate();
  const { toggleConnection } = useHomeConnection();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target;
      const targetIsEditable = target instanceof HTMLElement && (target.isContentEditable
        || !!target.closest("input, textarea, select, [role='textbox']"));
      const action = resolveShortcut({ key: event.key, metaKey: event.metaKey,
        ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, targetIsEditable });
      if (!action) return;
      event.preventDefault();
      if (action.type === "navigate") navigate(action.path);
      else void toggleConnection();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [navigate, toggleConnection]);
}
