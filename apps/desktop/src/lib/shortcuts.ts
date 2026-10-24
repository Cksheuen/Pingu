export type Action = { type: "navigate"; path: string } | { type: "toggleConnection" };
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  targetIsEditable: boolean;
}

export function resolveShortcut(event: ShortcutEvent): Action | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  const paths = ["/", "/route", "/sources", "/routing", "/activity", "/settings"];
  if (/^[1-6]$/.test(event.key)) return { type: "navigate", path: paths[Number(event.key) - 1] };
  if (event.key === "Enter" && !event.targetIsEditable) return { type: "toggleConnection" };
  return null;
}
