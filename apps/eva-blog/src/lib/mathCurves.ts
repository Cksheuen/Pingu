// 数学曲线模块：4 种滚动确定性曲线（Harmonograph / Lissajous / FlowField / Archimedean），
// 绘制到 Canvas 2D。所有曲线是滚动进度 s ∈ [0,1] 的纯函数：
// 预计算只做一次（createMathCurves），每帧仅索引/插值 + 批量绘制（drawMathCurves）。
// 场景坐标系 900×640（与 SVG viewBox 一致）；归一化坐标按 x*300+450, y*200+320 映射。
// cover 变换由调用方应用，本模块只在场景坐标系内绘制。

import { smoothstep } from "./svgRenderer";

// ── 场景常量 ─────────────────────────────────────────────

const SCENE_W = 900;
const SCENE_H = 640;
const CX = SCENE_W / 2; // 450
const CY = SCENE_H / 2; // 320

// 归一化坐标 [-1,1] → 场景坐标
const mapX = (x: number): number => x * 300 + CX;
const mapY = (y: number): number => y * 200 + CY;

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
  COLOR: "#4d72cf",
  LINE_WIDTH: 2,
} as const;

function precomputeHarmonograph(): Float32Array {
  const pts = new Float32Array(HARM.SAMPLES * 2);
  const dt = HARM.T_MAX / (HARM.SAMPLES - 1);
  for (let i = 0; i < HARM.SAMPLES; i++) {
    const t = i * dt;
    const decay = Math.exp(-HARM.DAMP * t); // 四路阻尼相同，复用
    const x = Math.sin(HARM.F1 * t + HARM.P1) * decay + Math.sin(HARM.F2 * t + HARM.P2) * decay;
    const y = Math.sin(HARM.F3 * t + HARM.P3) * decay + Math.sin(HARM.F4 * t + HARM.P4) * decay;
    pts[i * 2] = mapX(x);
    pts[i * 2 + 1] = mapY(y);
  }
  return pts;
}

type CurveContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" |
  "setLineDash" | "globalAlpha" | "strokeStyle" | "lineWidth" | "fillStyle">;

function drawHarmonograph(ctx: CurveContext, pts: Float32Array, s: number): void {
  // 从尾部开始消失：绘制前 N(s) 个点，N 从 500 递减到 0
  const n = Math.floor(HARM.SAMPLES * (1 - smoothstep(s, 0.05, 0.45)));
  if (n < 2) return;
  ctx.strokeStyle = HARM.COLOR;
  ctx.lineWidth = HARM.LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  ctx.stroke();
}

// ── 2. Lissajous（相位随滚动漂移）─────────────────────────

const LISSA = {
  A: 3, B: 4, // 频率比 3:4
  DELTA0: 0, K: Math.PI / 2, // δ(s) = δ0 + k·s
  SAMPLES: 300,
  T_MAX: 2 * Math.PI * 4,
  COLOR: "#69c9d8",
  LINE_WIDTH: 1.5,
  DASH: [8, 16],
} as const;

interface LissajousParams {
  a: number;
  b: number;
  delta0: number;
  k: number;
  samples: number;
  tMax: number;
}

// 每帧实时计算：300 点 × 600 次三角函数 < 0.1ms，无需预计算
// 消失方式：t 范围从 T_MAX 缩减到 0，曲线从尾部开始消失
function drawLissajous(ctx: CurveContext, params: LissajousParams, s: number): void {
  const delta = params.delta0 + params.k * s;
  const tMax = params.tMax * (1 - smoothstep(s, 0.15, 0.55));
  if (tMax < 0.01) return;
  const dt = tMax / (params.samples - 1);
  ctx.strokeStyle = LISSA.COLOR;
  ctx.lineWidth = LISSA.LINE_WIDTH;
  ctx.setLineDash([...LISSA.DASH]);
  ctx.beginPath();
  for (let i = 0; i < params.samples; i++) {
    const t = i * dt;
    const x = mapX(Math.sin(params.a * t + delta));
    const y = mapY(Math.sin(params.b * t));
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
  COLOR: "#d46b61",
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

function precomputeFlowField(): Float32Array {
  const rand = mulberry32(20260814);
  const paths = new Float32Array(FLOW.PARTICLES * FLOW.STEPS * 2);
  const cellW = SCENE_W / FLOW.GRID; // 112.5
  const cellH = SCENE_H / FLOW.GRID; // 80
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

function drawFlowField(ctx: CurveContext, paths: Float32Array, s: number, cx: number, cy: number): void {
  // 粒子数量从 64 递减到 0，从尾部开始消失
  const visible = Math.floor(FLOW.PARTICLES * (1 - smoothstep(s, 0.25, 0.65)));
  if (visible < 1) return;
  // 沿预计算轨迹插值取位（step 索引 = s · 119，对应场时间 s · 10）
  const f = s * (FLOW.STEPS - 1);
  const i0 = Math.min(FLOW.STEPS - 2, Math.floor(f));
  const frac = f - i0;
  // 末段（s > 0.7）向场景中心汇聚
  const conv = smoothstep(s, 0.7, 1);
  ctx.fillStyle = FLOW.COLOR;
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
  A: 0, B: 15,
  SAMPLES: 200,
  THETA_MAX: 4 * Math.PI, // 2 圈
  COLOR: "#26374d",
  LINE_WIDTH: 1.5,
} as const;

function precomputeSpiral(): Float32Array {
  const pts = new Float32Array(SPIRAL.SAMPLES * 2);
  const dt = SPIRAL.THETA_MAX / (SPIRAL.SAMPLES - 1);
  for (let i = 0; i < SPIRAL.SAMPLES; i++) {
    const theta = i * dt;
    const r = SPIRAL.A + SPIRAL.B * theta;
    pts[i * 2] = CX + r * Math.cos(theta);
    pts[i * 2 + 1] = CY + r * Math.sin(theta);
  }
  return pts;
}

function drawSpiral(ctx: CurveContext, pts: Float32Array, s: number): void {
  // 从尾部开始消失：绘制前 N(s) 个点，N 从 200 递减到 0
  const n = Math.floor(SPIRAL.SAMPLES * (1 - smoothstep(s, 0.35, 0.75)));
  if (n < 2) return;
  ctx.strokeStyle = SPIRAL.COLOR;
  ctx.lineWidth = SPIRAL.LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  ctx.stroke();
}

// ── 公开 API ─────────────────────────────────────────────

export interface MathCurves {
  harmonograph: Float32Array;
  // Lissajous 每帧实时计算，仅保留参数
  lissajous: LissajousParams;
  flowField: Float32Array;
  spiral: Float32Array;
}

// 预计算曲线数据（场景初始化时调用一次）
export function createMathCurves(): MathCurves {
  return {
    harmonograph: precomputeHarmonograph(),
    lissajous: {
      a: LISSA.A,
      b: LISSA.B,
      delta0: LISSA.DELTA0,
      k: LISSA.K,
      samples: LISSA.SAMPLES,
      tMax: LISSA.T_MAX,
    },
    flowField: precomputeFlowField(),
    spiral: precomputeSpiral(),
  };
}

// 绘制所有曲线（每帧调用）。sceneWidth/sceneHeight 决定粒子汇聚中心，默认 900×640；
// 曲线本身按 900×640 场景坐标系生成，cover 变换由调用方应用。
export function drawMathCurves(ctx: CurveContext, curves: MathCurves, s: number, sceneWidth: number = SCENE_W, sceneHeight: number = SCENE_H): void {
  const env = curveEnvelope(s);
  if (env < 0.01) return; // 包络早退：首尾不绘制

  ctx.save();
  ctx.globalAlpha = env;

  drawHarmonograph(ctx, curves.harmonograph, s);
  drawLissajous(ctx, curves.lissajous, s);
  drawFlowField(ctx, curves.flowField, s, sceneWidth / 2, sceneHeight / 2);
  drawSpiral(ctx, curves.spiral, s);

  ctx.restore();
}
