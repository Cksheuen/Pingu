import { sparklinePath, type TrafficSample } from "../../lib/traffic-history";

export function Sparkline({ history }: { history: readonly TrafficSample[] }) {
  const width = 320;
  const height = 40;
  const down = sparklinePath(history.map(sample => sample.down), width, height);
  const up = sparklinePath(history.map(sample => sample.up), width, height);
  return <svg className="traffic-sparkline" viewBox={`0 0 ${width} ${height + 2}`} aria-hidden="true">
    {history.length > 1 && <path className="sparkline-area" d={`${down} L${width},${height} L0,${height} Z`} />}
    <path className="sparkline-down" d={down} vectorEffect="non-scaling-stroke" />
    <path className="sparkline-up" d={up} vectorEffect="non-scaling-stroke" />
  </svg>;
}
