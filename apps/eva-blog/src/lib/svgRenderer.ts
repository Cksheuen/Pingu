// SVG 矢量场景引擎：解析 SVG → 场景描述 → 按滚动进度逐元素绘制到 Canvas 2D。
// 不做任何光栅化：所有元素以矢量命令绘制，任意尺寸下保持清晰。
// 末态（s=1）与 <img class="brand-mark"> 的 object-fit: cover 渲染逐像素对齐。

// ── 场景元素类型 ──────────────────────────────────────────

export interface RectSpec {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

export interface CircleSpec {
  kind: "circle";
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke: string;
  width: number;
  // 红色标记点沿轨道曲线滑行
  ride: boolean;
}

export interface PathSpec {
  kind: "path";
  d: string;
  stroke: string;
  width: number;
  dash: number[] | null;
  // 保留 SVG 元素以获取 getTotalLength / getPointAtLength
  el?: SVGPathElement;
  length?: number;
  path2d?: Path2D;
  samples?: Array<{ x: number; y: number }>;
}

export interface TextSpec {
  kind: "text";
  x: number;
  y: number;
  text: string | null;
  fontFamily: string;
  size: number;
  letterSpacing: string;
  fill: string;
}

export type SceneElement = RectSpec | CircleSpec | PathSpec | TextSpec;

export interface Scene {
  width: number;
  height: number;
  elements: SceneElement[];
}

// 元素滚动状态（各字段按元素种类可选）
export interface ElementState {
  dx?: number;
  dy?: number;
  march?: number;
  alpha?: number;
  travelT?: number;
  scale?: number;
  rotation?: number;
}

export interface SceneState {
  s: number;
  bgAlpha: number;
  feather: number;
  radius: number;
  elements: ElementState[];
}

export interface DestRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoverTransform {
  scale: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// ── 缓动 ──────────────────────────────────────────────────

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeOutExpo = (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const smoothstep = (t: number, a: number, b: number): number => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};

// ── SVG Path 解析（Path2D 不可用时的兜底，如 Node 测试环境）────

type TraceContext = Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "bezierCurveTo" | "closePath">;

function traceSvgPath(ctx: TraceContext, d: string): void {
  const commands = d.match(/[a-zA-Z][^a-zA-Z]*/g);
  if (!commands) return;
  let x = 0, y = 0;
  for (const cmd of commands) {
    const type = cmd[0];
    const args = cmd.slice(1).trim().split(/[\s,]+/).map(Number);
    switch (type) {
      case "M": x = args[0]; y = args[1]; ctx.moveTo(x, y); break;
      case "L": x = args[0]; y = args[1]; ctx.lineTo(x, y); break;
      case "H": x = args[0]; ctx.lineTo(x, y); break;
      case "V": y = args[0]; ctx.lineTo(x, y); break;
      case "C": ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[4], args[5]); x = args[4]; y = args[5]; break;
      case "Z": ctx.closePath(); break;
    }
  }
}

// ── 解析 ──────────────────────────────────────────────────

const num = (v: string | null, fallback = 0): number => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
};

const parseDash = (v: string | null): number[] | null => {
  if (!v) return null;
  const parts = v.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
  return parts.length ? parts : null;
};

// 解析 SVG 文本，返回场景描述（含背景 rect——末态需要它与 brand-mark 对齐）
export function parseSvg(svgText: string): Scene {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) throw new Error("svgRenderer: no <svg> root");

  const viewBoxAttr = svg.getAttribute("viewBox");
  const viewBox = viewBoxAttr
    ? (() => {
        const [, , w, h] = viewBoxAttr.split(/[\s,]+/).map(Number);
        return { width: w, height: h };
      })()
    : { width: 900, height: 640 };

  const elements: SceneElement[] = [];
  for (const node of svg.children) {
    const tag = node.tagName.toLowerCase();
    if (tag === "title" || tag === "desc" || tag === "defs" || tag === "metadata") continue;
    const spec = buildSpec(node, tag);
    if (spec) elements.push(spec);
  }
  return { width: viewBox.width, height: viewBox.height, elements };
}

function buildSpec(node: Element, tag: string): SceneElement | null {
  if (tag === "rect") {
    return {
      kind: "rect",
      x: num(node.getAttribute("x")),
      y: num(node.getAttribute("y")),
      w: num(node.getAttribute("width")),
      h: num(node.getAttribute("height")),
      fill: node.getAttribute("fill") || "none",
    };
  }
  if (tag === "circle") {
    const fill = node.getAttribute("fill") || "none";
    return {
      kind: "circle",
      cx: num(node.getAttribute("cx")),
      cy: num(node.getAttribute("cy")),
      r: num(node.getAttribute("r")),
      fill,
      stroke: node.getAttribute("stroke") || "none",
      width: num(node.getAttribute("stroke-width"), 1),
      ride: fill.toLowerCase() === "#d46b61",
    };
  }
  if (tag === "path") {
    return {
      kind: "path",
      d: node.getAttribute("d") || "",
      stroke: node.getAttribute("stroke") || "none",
      width: num(node.getAttribute("stroke-width"), 1),
      dash: parseDash(node.getAttribute("stroke-dasharray")),
      el: node as SVGPathElement,
    };
  }
  if (tag === "text") {
    return {
      kind: "text",
      x: num(node.getAttribute("x")),
      y: num(node.getAttribute("y")),
      text: node.textContent,
      fontFamily: node.getAttribute("font-family") || "monospace",
      size: num(node.getAttribute("font-size"), 16),
      letterSpacing: node.getAttribute("letter-spacing") || "0",
      fill: node.getAttribute("fill") || "#000",
    };
  }
  return null;
}

// ── 预处理：长度、Path2D、滑行采样 ────────────────────────

export function prepareScene(scene: Scene): Scene {
  for (const spec of scene.elements) {
    if (spec.kind !== "path") continue;
    if (spec.el && typeof spec.el.getTotalLength === "function") {
      spec.length = spec.el.getTotalLength();
    }
    if (typeof Path2D !== "undefined") {
      spec.path2d = new Path2D(spec.d);
    }
  }

  // 预采样第一条实线（深色轨道曲线），供红点滑行
  const ridePath = scene.elements.find((e): e is PathSpec => e.kind === "path" && !e.dash && Boolean(e.el) && Boolean(e.length));
  if (ridePath && ridePath.el && ridePath.length) {
    ridePath.samples = [];
    const N = 256;
    for (let i = 0; i <= N; i++) {
      const pt = ridePath.el.getPointAtLength((ridePath.length * i) / N);
      ridePath.samples.push({ x: pt.x, y: pt.y });
    }
  }
  return scene;
}

// ── object-fit: cover 变换 ────────────────────────────────
// 与 <img object-fit: cover> 的中心裁剪数学一致：
//   ctx.translate(dx, dy); ctx.scale(scale, scale); ctx.translate(-sx, -sy);
// 后，源坐标系 [0..srcW]×[0..srcH] 恰好覆盖目标矩形。
export function coverTransform(srcW: number, srcH: number, dx: number, dy: number, dw: number, dh: number): CoverTransform | null {
  if (!srcW || !srcH || !dw || !dh) return null;
  const srcRatio = srcW / srcH;
  const dstRatio = dw / dh;
  let sw: number, sh: number, sx: number, sy: number;
  if (srcRatio > dstRatio) {
    sh = srcH;
    sw = sh * dstRatio;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = sw / dstRatio;
    sx = 0;
    sy = (srcH - sh) / 2;
  }
  return { scale: dw / sw, sx, sy, sw, sh };
}

// ── 滚动状态：s ∈ [0,1]（0 = hero 全屏，1 = brand 40×40）────

export function sceneState(scene: Scene, s: number): SceneState {
  s = clamp01(s);
  return {
    s,
    // 背景纸色在形变后半段淡入，末态不透明（与 brand-mark 一致）
    bgAlpha: smoothstep(s, 0.5, 0.8),
    // 软边羽化随形变收敛到 0
    feather: 80 * (1 - smoothstep(s, 0.6, 0.9)),
    // 圆角收敛到 brand-mark 的 2px（--radius-sm 3px - 1px border）
    radius: 2 * smoothstep(s, 0.7, 1),
    elements: scene.elements.map((spec) => elementState(spec, s)),
  };
}

// 元素始终可见，仅位移/缩放（用户决策：不要渐进绘制）。
// 所有位移都以 sin(s·π) 为包络，s=0 与 s=1 时归零，
// 保证 85% 滚动处画布与静态 brand-mark 逐像素一致。
// 非核心元素（虚线、红点、文字）在滚动过程中逐渐消失，终态只保留核心元素。
function elementState(spec: SceneElement, s: number): ElementState {
  // 端点处 sin 精确归零，保证 s=1 画布与静态 brand-mark 逐像素一致
  const sin = s === 0 || s === 1 ? 0 : Math.sin(s * Math.PI);
  switch (spec.kind) {
    case "rect":
      return {};
    case "path": {
      if (spec.dash) {
        // 虚线曲线：漂移 + 虚线行进 + 逐渐消失（s=0.1 到 s=0.5）
        return { dx: sin * 8, dy: -sin * 6, march: 144 * s, alpha: 1 - smoothstep(s, 0.1, 0.5) };
      }
      // 实线：随滚动漂移，末态归零
      return { dx: sin * 6, dy: sin * 10 };
    }
    case "circle": {
      if (spec.ride) {
        // 红色标记点：沿轨道滑行 + 逐渐消失（s=0.2 到 s=0.6）
        return { travelT: easeInOutQuad(clamp01((s - 0.15) / 0.5)), alpha: 1 - smoothstep(s, 0.2, 0.6) };
      }
      if (spec.stroke && spec.stroke !== "none") {
        // 青色圆环：呼吸缩放（圆环绕中心旋转不可见，改用缩放）
        return { scale: 1 + sin * 0.05 };
      }
      // 蓝色圆点：微脉动
      return { scale: 1 + Math.sin(s * Math.PI * 2) * 0.08 };
    }
    case "text": {
      // 文字标签：下沉漂移 + 逐渐消失（s=0.3 到 s=0.7）
      return { dy: sin * 8, alpha: 1 - smoothstep(s, 0.3, 0.7) };
    }
  }
}

// 红点滑行位置：前 85% 沿轨道曲线，末段滑回静态位置 (cx, cy)
export function ridePosition(scene: Scene, travelT: number, dot: CircleSpec): { x: number; y: number } {
  const ride = scene.elements.find((e): e is PathSpec => e.kind === "path" && Boolean(e.samples));
  if (!ride || !ride.samples) return { x: dot.cx, y: dot.cy };
  const curveT = Math.min(1, travelT / 0.85);
  const idx = curveT * (ride.samples.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(ride.samples.length - 1, i0 + 1);
  const frac = idx - i0;
  const p0 = ride.samples[i0];
  const p1 = ride.samples[i1];
  const cx = lerp(p0.x, p1.x, frac);
  const cy = lerp(p0.y, p1.y, frac);
  const blend = smoothstep(travelT, 0.8, 1);
  return { x: lerp(cx, dot.cx, blend), y: lerp(cy, dot.cy, blend) };
}

// ── 绘制 ──────────────────────────────────────────────────

type DrawContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "translate" | "scale" | "rotate" | "beginPath" | "moveTo" | "lineTo" |
  "bezierCurveTo" | "arcTo" | "closePath" | "arc" | "fillRect" | "stroke" | "fill" | "clip" |
  "clearRect" | "setLineDash" | "createLinearGradient" | "fillText" | "globalAlpha" |
  "globalCompositeOperation" | "fillStyle" | "strokeStyle" | "lineWidth" | "lineJoin" |
  "lineCap" | "lineDashOffset" | "font" | "letterSpacing">;

export function renderScene(ctx: DrawContext, scene: Scene, state: SceneState, dest: DestRect): void {
  const cover = coverTransform(scene.width, scene.height, dest.x, dest.y, dest.w, dest.h);
  if (!cover) return;
  ctx.save();
  ctx.translate(dest.x, dest.y);
  ctx.scale(cover.scale, cover.scale);
  ctx.translate(-cover.sx, -cover.sy);
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";

  scene.elements.forEach((spec, i) => {
    drawElement(ctx, spec, state.elements[i], scene, state);
  });
  ctx.restore();
}

function strokePath(ctx: DrawContext, spec: PathSpec): void {
  if (spec.path2d) {
    ctx.stroke(spec.path2d);
  } else {
    ctx.beginPath();
    traceSvgPath(ctx, spec.d);
    ctx.stroke();
  }
}

function drawElement(ctx: DrawContext, spec: SceneElement, st: ElementState, scene: Scene, state: SceneState): void {
  switch (spec.kind) {
    case "rect": {
      ctx.globalAlpha = state.bgAlpha;
      ctx.fillStyle = spec.fill;
      ctx.fillRect(spec.x, spec.y, spec.w, spec.h);
      ctx.globalAlpha = 1;
      return;
    }
    case "path": {
      if (!spec.length) return;
      ctx.save();
      if (st.dx || st.dy) ctx.translate(st.dx || 0, st.dy || 0);
      if (st.alpha !== undefined) ctx.globalAlpha = st.alpha;
      ctx.strokeStyle = spec.stroke;
      ctx.lineWidth = spec.width;
      if (spec.dash) {
        // 虚线纹理 + 行进
        ctx.setLineDash(spec.dash);
        ctx.lineDashOffset = -st.march!;
        strokePath(ctx, spec);
      } else {
        strokePath(ctx, spec);
      }
      ctx.restore();
      ctx.setLineDash([]);
      return;
    }
    case "circle": {
      if (spec.ride) {
        // 红色标记点沿轨道滑行
        const pos = ridePosition(scene, st.travelT ?? 0, spec);
        if (st.alpha !== undefined) ctx.globalAlpha = st.alpha;
        ctx.fillStyle = spec.fill;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, spec.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }
      ctx.save();
      if (st.rotation) {
        // 圆环旋转
        ctx.translate(spec.cx, spec.cy);
        ctx.rotate((st.rotation * Math.PI) / 180);
        ctx.translate(-spec.cx, -spec.cy);
      }
      if (st.scale && st.scale !== 1) {
        // 圆点脉动
        ctx.translate(spec.cx, spec.cy);
        ctx.scale(st.scale, st.scale);
        ctx.translate(-spec.cx, -spec.cy);
      }
      if (spec.stroke && spec.stroke !== "none") {
        ctx.strokeStyle = spec.stroke;
        ctx.lineWidth = spec.width;
        ctx.beginPath();
        ctx.arc(spec.cx, spec.cy, spec.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (spec.fill && spec.fill !== "none") {
        ctx.fillStyle = spec.fill;
        ctx.beginPath();
        ctx.arc(spec.cx, spec.cy, spec.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    case "text": {
      ctx.save();
      if (st.dy) ctx.translate(0, st.dy);
      if (st.alpha !== undefined) ctx.globalAlpha = st.alpha;
      ctx.fillStyle = spec.fill;
      ctx.font = `${spec.size}px ${spec.fontFamily}`;
      if ("letterSpacing" in ctx) ctx.letterSpacing = spec.letterSpacing;
      ctx.fillText(spec.text ?? "", spec.x, spec.y);
      ctx.restore();
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      return;
    }
  }
}

// ── 抓取 + 缓存 ───────────────────────────────────────────

const sceneCache = new Map<string, Promise<Scene>>();

export function fetchScene(url: string): Promise<Scene> {
  if (!sceneCache.has(url)) {
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`svgRenderer fetch ${res.status}`);
        return res.text();
      })
      .then((text) => prepareScene(parseSvg(text)))
      .catch((err) => {
        sceneCache.delete(url);
        throw err;
      });
    sceneCache.set(url, promise);
  }
  return sceneCache.get(url)!;
}
