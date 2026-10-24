export interface TrafficSample { down: number; up: number; }

export function pushSample<T>(history: readonly T[], sample: T, max = 60): T[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 60;
  return limit ? [...history.slice(Math.max(0, history.length - limit + 1)), sample] : [];
}

export function sparklinePath(values: readonly number[], width: number, height: number): string {
  if (!values.length || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  const clean = values.map(value => Number.isFinite(value) ? Math.max(0, value) : 0);
  const peak = Math.max(1, ...clean);
  const y = (value: number) => Number((height - value / peak * height).toFixed(2));
  if (clean.length === 1) return `M0,${y(clean[0])} L${width},${y(clean[0])}`;
  return clean.map((value, index) =>
    `${index ? "L" : "M"}${Number((index / (clean.length - 1) * width).toFixed(2))},${y(value)}`,
  ).join(" ");
}
