// 数学曲线模块：4 种滚动确定性曲线（Harmonograph / Lissajous / FlowField / Archimedean），
// 绘制到 Canvas 2D。所有曲线是滚动进度 s ∈ [0,1] 的纯函数：
// 预计算只做一次（createMathCurves），每帧仅索引/插值 + 批量绘制（drawMathCurves）。
// 场景坐标系默认 900×640（与 SVG viewBox 一致）；归一化坐标按 x*w/3+w/2, y*h/3.2+h/2 映射。
// cover 变换由调用方应用，本模块只在场景坐标系内绘制。
// 支持路由切换时的 liquid morph：颜色、Lissajous 参数、曲线几何连续插值。
//
// ── 默认值文档 ──────────────────────────────────────────
//
// 4 种曲线的默认参数（DEFAULT_TUNING）：
//
// 1. Harmonograph（阻尼简谐运动合成，模拟摆笔画图机）
//    - 采样数：500 点，时间范围 [0, 20]
//    - 频率：f1=2.0, f2=3.0, f3=3.0, f4=2.0（微失谐 → 有机感）
//    - 相位：p1=0, p2=π/4, p3=π/2, p4=3π/4
//    - 阻尼系数：0.3
//    - 线宽：2px
//    - 默认颜色：#4d72cf（钴蓝）
//    - 消失方式：从尾部开始，s ∈ [0.05, 0.45] 内点数从 500 递减到 0
//
// 2. Lissajous（相位随滚动漂移）
//    - 采样数：300 点，时间范围 [0, 8π]
//    - 默认参数：a=3, b=4, delta0=0, k=π/2
//    - 线宽：1.5px，虚线 [8, 16]
//    - 默认颜色：#69c9d8（青色）
//    - 消失方式：t 范围从 8π 缩减到 0，s ∈ [0.15, 0.55]
//    - 各路由可通过 CurveTuning.lissajous 覆盖 a/b/delta0/k
//
// 3. FlowField（64 粒子沿 sin/cos 流场运动）
//    - 粒子数：64，步数：120，速度：2.0
//    - 场时间：t(s) = s × 10
//    - 网格：8×8 均匀撒点 + 确定性抖动（mulberry32, seed=20260814）
//    - 粒子半径：2px
//    - 默认颜色：#d46b61（赭红）
//    - 消失方式：粒子数从 64 递减到 0，s ∈ [0.25, 0.65]
//    - 末段（s > 0.7）：向场景中心汇聚
//
// 4. Archimedean 螺线
//    - 采样数：200 点，角度范围 [0, 4π]（2 圈）
//    - 默认参数：a=0, b=15
//    - 线宽：1.5px
//    - 默认颜色：#26374d（深墨蓝）
//    - 消失方式：从尾部开始，s ∈ [0.35, 0.75] 内点数从 200 递减到 0
//
// ── 素材替换说明 ────────────────────────────────────────
//
// 当前默认使用纯数学实现（上述 4 种曲线）。如果未来要替换为图片素材：
//
// 1. 素材格式：SVG（推荐）或 PNG/WebP（需透明背景）
// 2. SVG 要求：
//    - viewBox="0 0 900 640"（与场景坐标系一致）
//    - 扁平结构，无嵌套 <g>
//    - 元素顺序与 canonical topology 一致（见 artworkConfig.ts）
//    - 同索引位置的路径必须有相同的命令骨架（相同命令字母+参数数量），
//      这样 lerpPathD 才能做数值插值实现 liquid morph
// 3. 替换方式：
//    - 在 ArtworkConfig 中添加 assetSrc 字段（可选）
//    - useArtworkCanvas 中优先加载 assetSrc，回退到数学曲线
//    - 数学实现保持为默认值，素材为可选覆盖
// 4. 注意：素材替换后，liquid morph 的几何插值依赖 SVG 拓扑一致性。
//    如果素材拓扑不匹配，会降级为 alpha 交叉淡入淡出。

import { smoothstep } from "./svgRenderer";
import { lerpColor } from "./liquidMorph";

// ── 默认场景常量 ─────────────────────────────────────────

export const DEFAULT_SCENE_W = 900;
export const DEFAULT_SCENE_H = 640;

// 归一化坐标 [-1,1] → 场景坐标
const mapX = (x: number, w: number): number => x * (w / 3) + w / 2;
const mapY = (y: number, h: number): number => y * (h / 3.2) + h / 2;

// ── 调优参数 ─────────────────────────────────────────────

export interface CurveColors {
  harmonograph: string;
  lissajous: string;
  flowField: string;
  spiral: string;
}

export interface CurveTuning {
  lissajous: { a: number; b: number; delta0: number; k: number };
  spiral: { a: number; b: number };
  colors: Partial<CurveColors>;
}

export const DEFAULT_TUNING: CurveTuning = {
  lissajous: { a: 3, b: 4, delta0: 0, k: Math.PI / 2 },
  spiral: { a: 0, b: 15 },
  colors: {
    harmonograph: "#4d72cf",
    lissajous: "#69c9d8",
    flowField: "#d46b61",
    spiral: "#26374d",
  },
};

// ── 统一可见性包络 ────────────────────────────────────────

// s=0 时全部可见，s=1 时全部消失。各曲线有自己的消失时间窗口，
// 包络只保证终态干净：s > 0.95 时所有曲线不可见。
export function curveEnvelope(s: number): number {
  return 1 - smoothstep(s, 0.7, 0.95);
}

// ── 1. Harmonograph（阻尼简谐运动合成，模拟摆笔画图机）─────

const HARM = {
  SAMPLES: 500,
  T_MAX: 20,
  F1: 2.0, F2: 3.0, F3: 3.0, F4: 2.0, // 微失谐 → 有机感
  P1: 0, P2: Math.PI / 4, P3: Math.PI / 2, P4: (3 * Math.PI) / 4,
  DAMP: 0.3,
  LINE_WIDTH: 2,
} as const;

function precomputeHarmonograph(sceneW: number, sceneH: number): Float32Array {
  const pts = new Float32Array(HARM.SAMPLES * 2);
  const dt = HARM.T_MAX / (HARM.SAMPLES - 1);
  for (let i = 0; i < HARM.SAMPLES; i++) {
    const t = i * dt;
    const decay = Math.exp(-HARM.DAMP * t); // 四路阻尼相同，复用
    const x = Math.sin(HARM.F1 * t + HARM.P1) * decay + Math.sin(HARM.F2 * t + HARM.P2) * decay;
    const y = Math.sin(HARM.F3 * t + HARM.P3) * decay + Math.sin(HARM.F4 * t + HARM.P4) * decay;
    pts[i * 2] = mapX(x, sceneW);
    pts[i * 2 + 1] = mapY(y, sceneH);
  }
  return pts;
}

type CurveContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" |
  "setLineDash" | "globalAlpha" | "strokeStyle" | "lineWidth" | "fillStyle">;

function drawHarmonograph(ctx: CurveContext, pts: Float32Array, s: number, color: string): void {
  // 从尾部开始消失：绘制前 N(s) 个点，N 从 500 递减到 0
  const n = Math.floor(HARM.SAMPLES * (1 - smoothstep(s, 0.05, 0.45)));
  if (n < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = HARM.LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  ctx.stroke();
}

// ── 2. Lissajous（相位随滚动漂移）─────────────────────────

const LISSA = {
  SAMPLES: 300,
  T_MAX: 2 * Math.PI * 4,
  LINE_WIDTH: 1.5,
  DASH: [8, 16],
} as const;

export interface LissajousParams {
  a: number;
  b: number;
  delta0: number;
  k: number;
  samples: number;
  tMax: number;
}

// 每帧实时计算：300 点 × 600 次三角函数 < 0.1ms，无需预计算
// 消失方式：t 范围从 T_MAX 缩减到 0，曲线从尾部开始消失
function drawLissajous(ctx: CurveContext, params: LissajousParams, s: number, color: string, sceneW: number, sceneH: number): void {
  const delta = params.delta0 + params.k * s;
  const tMax = params.tMax * (1 - smoothstep(s, 0.15, 0.55));
  if (tMax < 0.01) return;
  const dt = tMax / (params.samples - 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = LISSA.LINE_WIDTH;
  ctx.setLineDash([...LISSA.DASH]);
  ctx.beginPath();
  for (let i = 0; i < params.samples; i++) {
    const t = i * dt;
    const x = mapX(Math.sin(params.a * t + delta), sceneW);
    const y = mapY(Math.sin(params.b * t), sceneH);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── 3. FlowField（64 粒子沿 sin/cos 流场运动）──────────────

const FLOW = {
  PARTICLES: 64,
  STEPS: 120,
  SPEED: 2.0,
  T_MAX: 10, // 场时间 t(s) = s · 10
  RADIUS: 2,
  GRID: 8, // 8×8 网格均匀撒点
} as const;

// 确定性 PRNG：初始位置的网格抖动固定，保证滚动确定
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function precomputeFlowField(sceneW: number, sceneH: number): Float32Array {
  const rand = mulberry32(20260814);
  const paths = new Float32Array(FLOW.PARTICLES * FLOW.STEPS * 2);
  const cellW = sceneW / FLOW.GRID;
  const cellH = sceneH / FLOW.GRID;
  for (let p = 0; p < FLOW.PARTICLES; p++) {
    const gx = p % FLOW.GRID;
    const gy = (p / FLOW.GRID) | 0;
    // 网格中心 + 半步抖动：均匀分布且带有机感
    let x = (gx + 0.5) * cellW + (rand() - 0.5) * cellW;
    let y = (gy + 0.5) * cellH + (rand() - 0.5) * cellH;
    const base = p * FLOW.STEPS * 2;
    paths[base] = x;
    paths[base + 1] = y;
    for (let step = 1; step < FLOW.STEPS; step++) {
      const t = (step / (FLOW.STEPS - 1)) * FLOW.T_MAX; // 场时间 t(s) = s·10
      const theta = Math.sin(x * 0.01 + t) + Math.cos(y * 0.01 + t * 0.7);
      x += Math.cos(theta) * FLOW.SPEED; // 空间推进 Δt = 1
      y += Math.sin(theta) * FLOW.SPEED;
      paths[base + step * 2] = x;
      paths[base + step * 2 + 1] = y;
    }
  }
  return paths;
}

function drawFlowField(ctx: CurveContext, paths: Float32Array, s: number, cx: number, cy: number, color: string): void {
  // 粒子数量从 64 递减到 0，从尾部开始消失
  const visible = Math.floor(FLOW.PARTICLES * (1 - smoothstep(s, 0.25, 0.65)));
  if (visible < 1) return;
  // 沿预计算轨迹插值取位（step 索引 = s · 119，对应场时间 s · 10）
  const f = s * (FLOW.STEPS - 1);
  const i0 = Math.min(FLOW.STEPS - 2, Math.floor(f));
  const frac = f - i0;
  // 末段（s > 0.7）向场景中心汇聚
  const conv = smoothstep(s, 0.7, 1);
  ctx.fillStyle = color;
  for (let p = 0; p < visible; p++) {
    const base = p * FLOW.STEPS * 2;
    const x0 = paths[base + i0 * 2];
    const y0 = paths[base + i0 * 2 + 1];
    const x1 = paths[base + (i0 + 1) * 2];
    const y1 = paths[base + (i0 + 1) * 2 + 1];
    let x = x0 + (x1 - x0) * frac;
    let y = y0 + (y1 - y0) * frac;
    if (conv > 0) {
      x += (cx - x) * conv;
      y += (cy - y) * conv;
    }
    ctx.beginPath();
    ctx.arc(x, y, FLOW.RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── 4. Archimedean 螺线 ──────────────────────────────────

const SPIRAL = {
  SAMPLES: 200,
  THETA_MAX: 4 * Math.PI, // 2 圈
  LINE_WIDTH: 1.5,
} as const;

function precomputeSpiral(sceneW: number, sceneH: number, a: number, b: number): Float32Array {
  const pts = new Float32Array(SPIRAL.SAMPLES * 2);
  const dt = SPIRAL.THETA_MAX / (SPIRAL.SAMPLES - 1);
  const cx = sceneW / 2;
  const cy = sceneH / 2;
  for (let i = 0; i < SPIRAL.SAMPLES; i++) {
    const theta = i * dt;
    const r = a + b * theta;
    pts[i * 2] = cx + r * Math.cos(theta);
    pts[i * 2 + 1] = cy + r * Math.sin(theta);
  }
  return pts;
}

function drawSpiral(ctx: CurveContext, pts: Float32Array, s: number, color: string): void {
  // 从尾部开始消失：绘制前 N(s) 个点，N 从 200 递减到 0
  const n = Math.floor(SPIRAL.SAMPLES * (1 - smoothstep(s, 0.35, 0.75)));
  if (n < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = SPIRAL.LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  ctx.stroke();
}

// ── 公开 API ─────────────────────────────────────────────

/** morph 用的 scratch buffer，首次 morph 时懒分配，避免每帧分配 */
export interface MorphScratch {
  harmonograph: Float32Array;
  flowField: Float32Array;
  spiral: Float32Array;
}

export interface MathCurves {
  harmonograph: Float32Array;
  // Lissajous 每帧实时计算，仅保留参数
  lissajous: LissajousParams;
  flowField: Float32Array;
  spiral: Float32Array;
  colors: CurveColors;
  sceneW: number;
  sceneH: number;
  /** 内部 morph scratch，外部不应直接访问 */
  _scratch?: MorphScratch;
}

// 预计算曲线数据（场景初始化时调用一次）
// sceneW/sceneH 默认 900×640；tuning 可覆盖 Lissajous 参数、螺线参数和颜色
export function createMathCurves(
  sceneW: number = DEFAULT_SCENE_W,
  sceneH: number = DEFAULT_SCENE_H,
  tuning: Partial<CurveTuning> = {}
): MathCurves {
  const t: CurveTuning = {
    lissajous: { ...DEFAULT_TUNING.lissajous, ...tuning.lissajous },
    spiral: { ...DEFAULT_TUNING.spiral, ...tuning.spiral },
    colors: { ...DEFAULT_TUNING.colors, ...tuning.colors },
  };
  return {
    harmonograph: precomputeHarmonograph(sceneW, sceneH),
    lissajous: {
      a: t.lissajous.a,
      b: t.lissajous.b,
      delta0: t.lissajous.delta0,
      k: t.lissajous.k,
      samples: LISSA.SAMPLES,
      tMax: LISSA.T_MAX,
    },
    flowField: precomputeFlowField(sceneW, sceneH),
    spiral: precomputeSpiral(sceneW, sceneH, t.spiral.a, t.spiral.b),
    // spread 保证所有键存在，as 断言满足 MathCurves.colors 的完整类型
    colors: t.colors as CurveColors,
    sceneW,
    sceneH,
  };
}

// ── Morph 支持 ───────────────────────────────────────────

function lerpFloat32(dst: Float32Array, a: Float32Array, b: Float32Array, t: number): void {
  const n = Math.min(a.length, b.length, dst.length);
  for (let i = 0; i < n; i++) {
    dst[i] = a[i] + (b[i] - a[i]) * t;
  }
}

function getScratch(curves: MathCurves, from: MathCurves): MorphScratch {
  if (!curves._scratch) {
    curves._scratch = {
      harmonograph: new Float32Array(Math.max(curves.harmonograph.length, from.harmonograph.length)),
      flowField: new Float32Array(Math.max(curves.flowField.length, from.flowField.length)),
      spiral: new Float32Array(Math.max(curves.spiral.length, from.spiral.length)),
    };
  }
  return curves._scratch;
}

/** 路由切换时的 morph 状态：from 为旧路由曲线，t ∈ [0,1] 为过渡进度 */
export interface MorphState {
  from: MathCurves;
  t: number;
}

// 绘制所有曲线（每帧调用）。sceneWidth/sceneHeight 决定粒子汇聚中心，默认取 curves 自身的场景尺寸；
// morph 提供时，几何/颜色/Lissajous 参数在 from → curves 之间连续插值。
export function drawMathCurves(
  ctx: CurveContext,
  curves: MathCurves,
  s: number,
  sceneWidth?: number,
  sceneHeight?: number,
  morph?: MorphState
): void {
  const env = curveEnvelope(s);
  if (env < 0.01) return; // 包络早退：首尾不绘制

  const sw = sceneWidth ?? curves.sceneW;
  const sh = sceneHeight ?? curves.sceneH;

  ctx.save();
  ctx.globalAlpha = env;

  if (morph) {
    const { from, t } = morph;
    const scratch = getScratch(curves, from);

    // Lerp 几何数据到 scratch
    lerpFloat32(scratch.harmonograph, from.harmonograph, curves.harmonograph, t);
    lerpFloat32(scratch.flowField, from.flowField, curves.flowField, t);
    lerpFloat32(scratch.spiral, from.spiral, curves.spiral, t);

    // Lerp Lissajous 参数
    const lp: LissajousParams = {
      a: from.lissajous.a + (curves.lissajous.a - from.lissajous.a) * t,
      b: from.lissajous.b + (curves.lissajous.b - from.lissajous.b) * t,
      delta0: from.lissajous.delta0 + (curves.lissajous.delta0 - from.lissajous.delta0) * t,
      k: from.lissajous.k + (curves.lissajous.k - from.lissajous.k) * t,
      samples: curves.lissajous.samples,
      tMax: curves.lissajous.tMax,
    };

    // Lerp 颜色
    const colors: CurveColors = {
      harmonograph: lerpColor(from.colors.harmonograph, curves.colors.harmonograph, t),
      lissajous: lerpColor(from.colors.lissajous, curves.colors.lissajous, t),
      flowField: lerpColor(from.colors.flowField, curves.colors.flowField, t),
      spiral: lerpColor(from.colors.spiral, curves.colors.spiral, t),
    };

    // Lerp 场景尺寸（Lissajous 映射 + FlowField 汇聚中心）
    const mw = from.sceneW + (curves.sceneW - from.sceneW) * t;
    const mh = from.sceneH + (curves.sceneH - from.sceneH) * t;

    drawHarmonograph(ctx, scratch.harmonograph, s, colors.harmonograph);
    drawLissajous(ctx, lp, s, colors.lissajous, mw, mh);
    drawFlowField(ctx, scratch.flowField, s, mw / 2, mh / 2, colors.flowField);
    drawSpiral(ctx, scratch.spiral, s, colors.spiral);
  } else {
    drawHarmonograph(ctx, curves.harmonograph, s, curves.colors.harmonograph);
    drawLissajous(ctx, curves.lissajous, s, curves.colors.lissajous, sw, sh);
    drawFlowField(ctx, curves.flowField, s, sw / 2, sh / 2, curves.colors.flowField);
    drawSpiral(ctx, curves.spiral, s, curves.colors.spiral);
  }

  ctx.restore();
}
