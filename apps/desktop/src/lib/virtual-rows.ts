export interface VirtualRowsOptions {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan: number;
}

export function visibleRange({ scrollTop, viewportHeight, rowHeight, count, overscan }: VirtualRowsOptions) {
  const size = Math.max(0, Math.floor(count));
  if (!size || rowHeight <= 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  const totalHeight = size * rowHeight;
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)));
  const extra = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, Math.floor(top / rowHeight) - extra);
  const end = Math.min(size, Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight) + extra);
  return { start, end, offsetTop: start * rowHeight, totalHeight };
}
