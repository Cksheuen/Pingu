// orbitalPlume：orbital-plume-canvas2d-v1 的唯一默认绘制算子。
//
// 三层模型（Phase 1 数据结构 + prepare + morph；Phase 2 纯 2D 渲染器）：
//   - 远景：星星（dot / sparkle4 / star5 + halo），低 alpha 散布
//   - 中景：星球（core + 陨石坑 + 光照 + 大气光晕 + 椭圆轨道）
//   - 前景：K 根羽毛沿 golden-angle 螺旋独立分布（不锚定星球），方向沿切线，
//     位置随 scroll 进度 s 做 curl-noise 漂移（被风吹的感觉）
// 四个 route 只改 seed / 羽毛分布与漂移 / 星球光照 / 密度与窄色板，
// 因此 procedural -> procedural 的 route morph 是连续参数插值（同一算子、同一拓扑）。
//
// 统一逻辑坐标：以场景中心为原点，1 单位 = 场景高 H。
//   p = ((x - cx) / H, (y - cy) / H)
// prepare 阶段把所有几何烘焙进 typed arrays；render 阶段只索引/插值 + 批量绘制，
// 不采样随机数、不新建大数组。事件驱动调度由 useArtworkCanvas 负责，本模块无时间动画。
//
// 能力边界（替换契约）：
//   - procedural（本模块）：可参数 morph。
//   - vector（同 topologyId 的 SVG）：走 svgRenderer 的 topology morph（见 useArtworkCanvas）。
//   - raster / 任意素材：只承诺 composited crossfade/mask，不承诺 geometry morph。

import { smoothstep } from "./svgRenderer";
import { lerpColor } from "./liquidMorph";

// ── 类型 ─────────────────────────────────────────────────

export type Vec2 = [number, number];

export interface PlumeColors {
  core: string;
  ring: string;
  spine: string;
  barb: string;
  star: string;
  dust: string;
}

/** 归一化参数（1 单位 = 场景高）。四 route 只改这里 + seed。 */
export interface OrbitalPlumeParams {
  seed: number;
  /** 羽毛：golden-angle 螺旋独立分布（不锚定星球），方向沿切线，随 scroll 漂移 */
  feathers: {
    /** 基准长度 */
    length: number;
    /** 羽片基准半宽 */
    width: number;
    /** 宽度收尖指数 */
    taper: number;
    /** 沿程弯曲（控制点法向偏移） */
    curl: number;
    /** 方向/长度随机幅度 */
    jitter: number;
    /** 螺旋分布：spread=分布半径，jitter=位置随机幅度 */
    distribution: { spread: number; jitter: number };
    /** 滚动漂移：curl noise 幅度与频率（prepare 期烘焙，render 期乘 s） */
    drift: { amplitude: number; frequency: number };
  };
  /** 星球核心（s=1 仍绘制，是 brand crop 的主体） */
  core: { x: number; y: number; r: number };
  /** 星球表面：光照方向 / 大气强度 / 条纹（0=岩质）/ 条纹倾角 */
  planet: {
    lightAngle: number;
    atmosphere: number;
    /** 条纹条数，离散量 → morph 阈值切换 */
    bands: number;
    bandTilt: number;
  };
  /** 次级轨道：绕 core 的椭圆 */
  orbit: { rx: number; ry: number; rotation: number };
  /** 羽枝：每侧一层，长度沿 sin(πu)^taper 收尖，sweep 沿切向回掠 */
  barbs: { length: number; sweep: number; curl: number; taper: number };
  /** 星点：Fermat/golden-angle 螺旋散布 */
  stars: { spread: number; jitter: number };
  /** 轻量 curl 微扰（prepare 期烘焙进端点，render 期零成本） */
  curl: { amplitude: number; frequency: number };
  colors: PlumeColors;
}

/** 细节密度（prepare 期决定，quality 只改密度不改构图语义） */
export interface PlumeDensity {
  spineSamples: number;
  /** 每侧 barb 数，合同要求 12-24 */
  barbsPerSide: number;
  /** 星点数，合同要求 24-48 */
  starCount: number;
  orbitSamples: number;
  /** 羽毛根数 K（desktop=3, mobile=2） */
  featherCount: number;
  /** 陨石坑数量（desktop=8, mobile=5） */
  craterCount: number;
}

export const DESKTOP_DENSITY: PlumeDensity = {
  spineSamples: 64,
  barbsPerSide: 24,
  starCount: 48,
  orbitSamples: 96,
  featherCount: 5,
  craterCount: 8,
};

export const MOBILE_DENSITY: PlumeDensity = {
  spineSamples: 48,
  barbsPerSide: 12,
  starCount: 24,
  orbitSamples: 64,
  featherCount: 3,
  craterCount: 5,
};

/** 语义减法通道：值为该通道在 s 轴上的消失窗口 [a, b]。core 不在此列（永不消失）。 */
export interface PlumeChannels {
  stars: [number, number];
  outerBarbs: [number, number];
  innerBarbs: [number, number];
  secondaryOrbit: [number, number];
  spine: [number, number];
}

export const DEFAULT_CHANNELS: PlumeChannels = {
  stars: [0.05, 0.4],
  outerBarbs: [0.15, 0.55],
  innerBarbs: [0.3, 0.7],
  secondaryOrbit: [0.45, 0.85],
  spine: [0.6, 0.95],
};

export interface SafeZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** prepare 产物：全部几何在 typed arrays 里，render 期零分配 */
export interface PreparedPlume {
  params: OrbitalPlumeParams;
  channels: PlumeChannels;
  density: PlumeDensity;
  sceneW: number;
  sceneH: number;
  /** K 根羽毛的脊线采样点（场景坐标），2 * featherCount * spineSamples */
  spine: Float32Array;
  /** 脊线单位法向量，2 * featherCount * spineSamples */
  spineN: Float32Array;
  /** 每根羽毛的预计算漂移偏移（场景坐标 dx, dy），render 期乘 scroll s，2 * featherCount */
  featherDrift: Float32Array;
  /** 每根羽枝的 root/tip（场景坐标），4 * 2 * barbsPerSide */
  barbs: Float32Array;
  /** 星点 [x, y, r, alpha, rotation, halo, aspect]（场景坐标），7 * starCount */
  stars: Float32Array;
  /** 星点形状种类（0=dot 30% / 1=sparkle4 50% / 2=star5 20%），仅 [0, starCount) 有效 */
  starKinds: Uint8Array;
  /** 陨石坑 [nx, ny, r, depth]（相对 core 的归一化坐标），4 * craterCount */
  craters: Float32Array;
  /** safe-zone 过滤后实际接受的星点数 */
  starCount: number;
  /** 次级轨道采样点，2 * orbitSamples */
  orbit: Float32Array;
  core: { x: number; y: number; r: number };
  /** 几何预算（arc 按离散段数计） */
  vertexCount: number;
  /** morph scratch（内部使用，外部不应直接访问） */
  _scratch?: PreparedPlume;
}

export interface PlumeMorph {
  from: PreparedPlume;
  t: number;
}

/** 可选素材：星球表面纹理（WebGL 生成，失败为 null 时静默跳过） */
export interface PlumeAssets {
  surface: HTMLCanvasElement | null;
}

/** 渐变占位：CanvasRenderingContext2D 渐变的结构化子集，便于 Node 测试 */
export interface PlumeGradient {
  addColorStop(offset: number, color: string): void;
}

/** 绘制上下文：CanvasRenderingContext2D 的结构化子集，便于 Node 测试 */
export interface PlumeDrawContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number, counterclockwise?: boolean): void;
  clip(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ): PlumeGradient;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): PlumeGradient;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  globalAlpha: number;
  globalCompositeOperation: string;
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  lineWidth: number;
  lineCap: CanvasLineCap;
}

// ── 确定性随机 ────────────────────────────────────────────

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

// ── prepare ──────────────────────────────────────────────

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const STAR_ARC_SEGMENTS = 8;
const CORE_ARC_SEGMENTS = 40;
const CRATER_ARC_SEGMENTS = 8;
/** 陨石坑拒绝采样最大尝试次数（单位圆盘接受率 ≈ 81%，32 次失败概率可忽略） */
const CRATER_REJECTION_MAX = 32;
/** 陨石坑采样圆盘半径（留边距，避免坑缘穿出星球） */
const CRATER_DISK_RADIUS = 0.9;
/** 羽毛螺旋拒绝采样最大尝试次数（超出后退化为 core 切向放置） */
const FEATHER_PLACE_MAX_ATTEMPTS = 8;
/** 大星（r 超过该值）配 halo 渐变 */
const STAR_HALO_RADIUS = 1.6;

function quadPoint(p0: Vec2, p1: Vec2, p2: Vec2, u: number, out: Vec2): void {
  const iu = 1 - u;
  const a = iu * iu;
  const b = 2 * iu * u;
  const c = u * u;
  out[0] = a * p0[0] + b * p1[0] + c * p2[0];
  out[1] = a * p0[1] + b * p1[1] + c * p2[1];
}

function quadTangent(p0: Vec2, p1: Vec2, p2: Vec2, u: number, out: Vec2): void {
  const iu = 1 - u;
  out[0] = 2 * iu * (p1[0] - p0[0]) + 2 * u * (p2[0] - p1[0]);
  out[1] = 2 * iu * (p1[1] - p0[1]) + 2 * u * (p2[1] - p1[1]);
}

/** 标量势 ψ 的旋度场 v = (∂ψ/∂y, -∂ψ/∂x)，无散度；prepare 期烘焙，render 期不调用 */
function curlOffset(x: number, y: number, amplitude: number, frequency: number, phase: number, out: Vec2): void {
  const fx = frequency * x + phase;
  const fy = frequency * y + phase * 1.7;
  const sinX = Math.sin(fx);
  const cosX = Math.cos(fx);
  const sinY = Math.sin(fy);
  const cosY = Math.cos(fy);
  out[0] = amplitude * (-sinX * frequency * sinY);
  out[1] = amplitude * (-(frequency * cosX * cosY));
}

function inSafeZone(x: number, y: number, zones: readonly SafeZone[]): boolean {
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return true;
  }
  return false;
}

/**
 * prepare：route/resize/quality 变化时调用一次。
 * 所有几何（羽毛脊线、羽枝、星星、陨石坑、轨道、core）烘焙进 typed arrays；
 * 星点排除 composition.safeZones（标题区不与背景争夺）。
 */
export function prepareOrbitalPlume(
  params: OrbitalPlumeParams,
  sceneW: number,
  sceneH: number,
  density: PlumeDensity,
  channels: PlumeChannels = DEFAULT_CHANNELS,
  safeZones: readonly SafeZone[] = []
): PreparedPlume {
  const cx = sceneW / 2;
  const cy = sceneH / 2;
  const H = sceneH;
  const toX = (nx: number): number => cx + nx * H;
  const toY = (ny: number): number => cy + ny * H;

  const rand = mulberry32(params.seed);
  const phase = rand() * TAU;
  const coreNX = params.core.x;
  const coreNY = params.core.y;

  // ── 羽毛：golden-angle 螺旋独立分布（不锚定星球），方向沿切线；漂移 prepare 期烘焙 ──
  const K = density.featherCount;
  const spine = new Float32Array(K * density.spineSamples * 2);
  const spineN = new Float32Array(K * density.spineSamples * 2);
  const featherDrift = new Float32Array(K * 2);
  const fp = params.feathers;
  const root: Vec2 = [0, 0];
  const ctrl: Vec2 = [0, 0];
  const tip: Vec2 = [0, 0];
  const qp: Vec2 = [0, 0];
  const qt: Vec2 = [0, 0];
  const dv: Vec2 = [0, 0];
  let placed = 0;
  let attempt = 0;
  const featherMaxAttempts = K * FEATHER_PLACE_MAX_ATTEMPTS;
  while (placed < K) {
    let nx: number;
    let ny: number;
    let angle: number;
    if (attempt < featherMaxAttempts) {
      // Vogel 螺旋：angle = n·golden，radius = spread·√(n/K)
      angle = attempt * GOLDEN_ANGLE;
      const radius = fp.distribution.spread * Math.sqrt(attempt / K);
      nx = coreNX + radius * Math.cos(angle) + (rand() - 0.5) * fp.distribution.jitter;
      ny = coreNY + radius * Math.sin(angle) + (rand() - 0.5) * fp.distribution.jitter;
      attempt++;
      if (inSafeZone(toX(nx), toY(ny), safeZones)) continue;
    } else {
      // 兜底：拒绝采样耗尽时退化为 core 切向放置，避免零长几何
      nx = coreNX;
      ny = coreNY;
      angle = 0;
    }
    // 方向沿切线（垂直于半径）+ jitter；长度 + jitter
    const dirAngle = angle + Math.PI / 2 + (rand() - 0.5) * fp.jitter;
    const len = fp.length * (1 + (rand() - 0.5) * fp.jitter);
    const dirX = Math.cos(dirAngle);
    const dirY = Math.sin(dirAngle);
    root[0] = nx;
    root[1] = ny;
    tip[0] = nx + dirX * len;
    tip[1] = ny + dirY * len;
    // 控制点：弦中点 + 法向 curl 弯曲
    const perpX = -dirY;
    const perpY = dirX;
    ctrl[0] = nx + dirX * len * 0.5 + perpX * fp.curl * len;
    ctrl[1] = ny + dirY * len * 0.5 + perpY * fp.curl * len;
    for (let i = 0; i < density.spineSamples; i++) {
      const u = i / (density.spineSamples - 1);
      quadPoint(root, ctrl, tip, u, qp);
      quadTangent(root, ctrl, tip, u, qt);
      const tl = Math.hypot(qt[0], qt[1]) || 1;
      const idx = (placed * density.spineSamples + i) * 2;
      spine[idx] = toX(qp[0]);
      spine[idx + 1] = toY(qp[1]);
      spineN[idx] = -qt[1] / tl;
      spineN[idx + 1] = qt[0] / tl;
    }
    // 漂移：curl noise 在羽毛根部位置采样，烘焙为场景坐标偏移，render 期乘 scroll s
    curlOffset(nx, ny, fp.drift.amplitude, fp.drift.frequency, phase, dv);
    featherDrift[placed * 2] = dv[0] * H;
    featherDrift[placed * 2 + 1] = dv[1] * H;
    placed++;
  }

  // ── 羽枝：K 根羽毛均分，root 在羽毛脊线上，tip 沿法向伸出 + 切向 sweep + 缓存 curl ──
  const barbsPerSide = density.barbsPerSide;
  const barbs = new Float32Array(barbsPerSide * 2 * 4);
  const perFeather = Math.ceil(barbsPerSide / K);
  const curlAmp = params.curl.amplitude;
  const curlFreq = params.curl.frequency;
  const sweep = params.barbs.sweep;
  const taper = params.barbs.taper;
  const length = params.barbs.length;
  const c: Vec2 = [0, 0];
  let bi = 0;
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? -1 : 1;
    for (let i = 0; i < barbsPerSide; i++) {
      const k = i % K;
      const j = Math.floor(i / K);
      const u = (j + 0.5) / perFeather;
      const fi = Math.min(density.spineSamples - 1, Math.round(u * (density.spineSamples - 1)));
      const base = (k * density.spineSamples + fi) * 2;
      const bx = spine[base];
      const by = spine[base + 1];
      const nx = spineN[base];
      const ny = spineN[base + 1];
      const tx = -ny;
      const ty = nx;
      const L = length * Math.pow(Math.sin(Math.PI * u), taper);
      const sw = sweep * Math.sin(Math.PI * u);
      // curl 微扰在 prepare 期烘焙（归一化坐标 → 场景坐标）
      curlOffset((bx - cx) / H, (by - cy) / H, curlAmp * params.barbs.curl, curlFreq, phase, c);
      barbs[bi * 4] = bx;
      barbs[bi * 4 + 1] = by;
      barbs[bi * 4 + 2] = bx + (nx * sgn * L + tx * sw + c[0]) * H;
      barbs[bi * 4 + 3] = by + (ny * sgn * L + ty * sw + c[1]) * H;
      bi++;
    }
  }

  // ── 星点：golden-angle / Fermat 螺旋，排除 safeZones；属性 prepare 期随机烘焙 ──
  const stars = new Float32Array(density.starCount * 7);
  const starKinds = new Uint8Array(density.starCount);
  const spread = params.stars.spread;
  const jitter = params.stars.jitter;
  let si = 0;
  let n = 0;
  const maxAttempts = density.starCount * 8;
  while (si < density.starCount && n < maxAttempts) {
    const angle = n * GOLDEN_ANGLE + (rand() - 0.5) * jitter;
    const sampleIndex = n % density.starCount;
    const radius = spread * Math.sqrt((sampleIndex + 1) / density.starCount);
    const nx = coreNX + radius * Math.cos(angle);
    const ny = coreNY + radius * Math.sin(angle);
    const x = toX(nx);
    const y = toY(ny);
    n++;
    if (inSafeZone(x, y, safeZones)) continue;
    const r = 0.9 + rand() * 1.3;
    stars[si * 7] = x;
    stars[si * 7 + 1] = y;
    stars[si * 7 + 2] = r;
    stars[si * 7 + 3] = 0.35 + rand() * 0.55;
    stars[si * 7 + 4] = rand() * TAU; // 自转角
    stars[si * 7 + 5] = r > STAR_HALO_RADIUS ? 2 + rand() * 2 : 0; // 光晕半径倍数（小星不加）
    stars[si * 7 + 6] = 0.7 + rand() * 0.6; // 压扁比
    const roll = rand();
    starKinds[si] = roll < 0.3 ? 0 : roll < 0.8 ? 1 : 2; // dot 30% / sparkle4 50% / star5 20%
    si++;
  }

  const acceptedStarCount = si;

  // ── 陨石坑：星球圆盘内拒绝采样，归一化坐标（相对 core） ──
  const craters = new Float32Array(density.craterCount * 4);
  const craterDisk = CRATER_DISK_RADIUS * CRATER_DISK_RADIUS;
  for (let ci = 0; ci < density.craterCount; ci++) {
    let dx = 0;
    let dy = 0;
    for (let attempt = 0; attempt < CRATER_REJECTION_MAX; attempt++) {
      dx = rand() * 2 - 1;
      dy = rand() * 2 - 1;
      if (dx * dx + dy * dy <= craterDisk) break;
    }
    craters[ci * 4] = dx;
    craters[ci * 4 + 1] = dy;
    craters[ci * 4 + 2] = 0.08 + rand() * 0.12; // 半径（相对 core）
    craters[ci * 4 + 3] = 0.3 + rand() * 0.5; // 深度
  }

  // ── 次级轨道：绕 core 的椭圆 ──
  const orbit = new Float32Array(density.orbitSamples * 2);
  const cosR = Math.cos(params.orbit.rotation);
  const sinR = Math.sin(params.orbit.rotation);
  for (let i = 0; i < density.orbitSamples; i++) {
    const a = (i / (density.orbitSamples - 1)) * TAU;
    const ex = params.orbit.rx * Math.cos(a);
    const ey = params.orbit.ry * Math.sin(a);
    orbit[i * 2] = toX(coreNX + ex * cosR - ey * sinR);
    orbit[i * 2 + 1] = toY(coreNY + ex * sinR + ey * cosR);
  }

  const core = { x: toX(coreNX), y: toY(coreNY), r: params.core.r * H };

  const vertexCount =
    density.featherCount * density.spineSamples +
    barbsPerSide * 2 * 2 +
    acceptedStarCount * STAR_ARC_SEGMENTS +
    density.orbitSamples +
    CORE_ARC_SEGMENTS +
    density.craterCount * CRATER_ARC_SEGMENTS;

  return {
    params,
    channels,
    density,
    sceneW,
    sceneH,
    spine,
    spineN,
    featherDrift,
    barbs,
    stars,
    starKinds,
    craters,
    starCount: acceptedStarCount,
    orbit,
    core,
    vertexCount,
  };
}

// ── morph scratch ────────────────────────────────────────

function cloneParams(params: OrbitalPlumeParams): OrbitalPlumeParams {
  return {
    seed: params.seed,
    feathers: {
      length: params.feathers.length,
      width: params.feathers.width,
      taper: params.feathers.taper,
      curl: params.feathers.curl,
      jitter: params.feathers.jitter,
      distribution: { ...params.feathers.distribution },
      drift: { ...params.feathers.drift },
    },
    planet: { ...params.planet },
    core: { ...params.core },
    orbit: { ...params.orbit },
    barbs: { ...params.barbs },
    stars: { ...params.stars },
    curl: { ...params.curl },
    colors: { ...params.colors },
  };
}

function createScratch(to: PreparedPlume, from: PreparedPlume): PreparedPlume {
  const max2 = (a: Float32Array, b: Float32Array): number => Math.max(a.length, b.length);
  const maxBytes = (a: Uint8Array, b: Uint8Array): number => Math.max(a.length, b.length);
  return {
    params: cloneParams(to.params),
    channels: to.channels,
    density: to.density,
    sceneW: to.sceneW,
    sceneH: to.sceneH,
    spine: new Float32Array(max2(to.spine, from.spine)),
    spineN: new Float32Array(max2(to.spineN, from.spineN)),
    featherDrift: new Float32Array(max2(to.featherDrift, from.featherDrift)),
    barbs: new Float32Array(max2(to.barbs, from.barbs)),
    stars: new Float32Array(max2(to.stars, from.stars)),
    starKinds: new Uint8Array(maxBytes(to.starKinds, from.starKinds)),
    craters: new Float32Array(max2(to.craters, from.craters)),
    starCount: to.starCount,
    orbit: new Float32Array(max2(to.orbit, from.orbit)),
    core: { x: 0, y: 0, r: 0 },
    vertexCount: to.vertexCount,
  };
}

function lerpArray(dst: Float32Array, a: Float32Array, b: Float32Array, t: number): void {
  if (t <= 0) {
    dst.set(a);
    return;
  }
  if (t >= 1) {
    dst.set(b);
    return;
  }
  const n = Math.min(a.length, b.length, dst.length);
  for (let i = 0; i < n; i++) dst[i] = a[i] + (b[i] - a[i]) * t;
}

/** morph 只允许同一场景尺寸、数组长度、实际星点数与密度字段。 */
export function plumeTopologyCompatible(a: PreparedPlume, b: PreparedPlume): boolean {
  return (
    a.sceneW === b.sceneW &&
    a.sceneH === b.sceneH &&
    a.spine.length === b.spine.length &&
    a.spineN.length === b.spineN.length &&
    a.featherDrift.length === b.featherDrift.length &&
    a.barbs.length === b.barbs.length &&
    a.stars.length === b.stars.length &&
    a.starKinds.length === b.starKinds.length &&
    a.craters.length === b.craters.length &&
    a.orbit.length === b.orbit.length &&
    a.starCount === b.starCount &&
    a.density.spineSamples === b.density.spineSamples &&
    a.density.barbsPerSide === b.density.barbsPerSide &&
    a.density.starCount === b.density.starCount &&
    a.density.orbitSamples === b.density.orbitSamples &&
    a.density.featherCount === b.density.featherCount &&
    a.density.craterCount === b.density.craterCount
  );
}

/**
 * 把 from → to 的参数/几何插值进 scratch 并返回。
 * 不修改 from/to；scratch 缓存在 to._scratch 上复用（同密度 route 间数组等长）。
 * 连续参数 lerp；离散参数（planet.bands、starKinds）阈值整体切换。
 */
export function resolvePlumeMorph(plume: PreparedPlume, morph: PlumeMorph): PreparedPlume {
  const { from } = morph;
  if (!plumeTopologyCompatible(plume, from)) {
    throw new RangeError("Orbital plume morph requires compatible topology");
  }
  const t = Math.min(1, Math.max(0, morph.t));
  if (!plume._scratch || plume._scratch.spine.length < Math.max(plume.spine.length, from.spine.length)) {
    plume._scratch = createScratch(plume, from);
  }
  const scratch = plume._scratch;
  scratch.starCount = plume.starCount;
  scratch.vertexCount = plume.vertexCount;

  lerpArray(scratch.spine, from.spine, plume.spine, t);
  lerpArray(scratch.spineN, from.spineN, plume.spineN, t);
  lerpArray(scratch.featherDrift, from.featherDrift, plume.featherDrift, t);
  lerpArray(scratch.barbs, from.barbs, plume.barbs, t);
  lerpArray(scratch.stars, from.stars, plume.stars, t);
  lerpArray(scratch.craters, from.craters, plume.craters, t);
  lerpArray(scratch.orbit, from.orbit, plume.orbit, t);
  // starKinds 离散量：阈值整体拷贝（t < 0.5 用 from，否则用 to）
  scratch.starKinds.set(t < 0.5 ? from.starKinds : plume.starKinds);

  const fp = from.params;
  const tp = plume.params;
  const sp = scratch.params;
  // feathers 5 标量 + distribution/drift 嵌套连续插值
  sp.feathers.length = fp.feathers.length + (tp.feathers.length - fp.feathers.length) * t;
  sp.feathers.width = fp.feathers.width + (tp.feathers.width - fp.feathers.width) * t;
  sp.feathers.taper = fp.feathers.taper + (tp.feathers.taper - fp.feathers.taper) * t;
  sp.feathers.curl = fp.feathers.curl + (tp.feathers.curl - fp.feathers.curl) * t;
  sp.feathers.jitter = fp.feathers.jitter + (tp.feathers.jitter - fp.feathers.jitter) * t;
  sp.feathers.distribution.spread =
    fp.feathers.distribution.spread + (tp.feathers.distribution.spread - fp.feathers.distribution.spread) * t;
  sp.feathers.distribution.jitter =
    fp.feathers.distribution.jitter + (tp.feathers.distribution.jitter - fp.feathers.distribution.jitter) * t;
  sp.feathers.drift.amplitude =
    fp.feathers.drift.amplitude + (tp.feathers.drift.amplitude - fp.feathers.drift.amplitude) * t;
  sp.feathers.drift.frequency =
    fp.feathers.drift.frequency + (tp.feathers.drift.frequency - fp.feathers.drift.frequency) * t;
  // planet：3 标量连续插值 + bands 离散阈值切换
  sp.planet.lightAngle = fp.planet.lightAngle + (tp.planet.lightAngle - fp.planet.lightAngle) * t;
  sp.planet.atmosphere = fp.planet.atmosphere + (tp.planet.atmosphere - fp.planet.atmosphere) * t;
  sp.planet.bands = t < 0.5 ? fp.planet.bands : tp.planet.bands;
  sp.planet.bandTilt = fp.planet.bandTilt + (tp.planet.bandTilt - fp.planet.bandTilt) * t;
  sp.core.x = fp.core.x + (tp.core.x - fp.core.x) * t;
  sp.core.y = fp.core.y + (tp.core.y - fp.core.y) * t;
  sp.core.r = fp.core.r + (tp.core.r - fp.core.r) * t;
  sp.orbit.rx = fp.orbit.rx + (tp.orbit.rx - fp.orbit.rx) * t;
  sp.orbit.ry = fp.orbit.ry + (tp.orbit.ry - fp.orbit.ry) * t;
  sp.orbit.rotation = fp.orbit.rotation + (tp.orbit.rotation - fp.orbit.rotation) * t;
  sp.barbs.length = fp.barbs.length + (tp.barbs.length - fp.barbs.length) * t;
  sp.barbs.sweep = fp.barbs.sweep + (tp.barbs.sweep - fp.barbs.sweep) * t;
  sp.barbs.curl = fp.barbs.curl + (tp.barbs.curl - fp.barbs.curl) * t;
  sp.barbs.taper = fp.barbs.taper + (tp.barbs.taper - fp.barbs.taper) * t;
  sp.stars.spread = fp.stars.spread + (tp.stars.spread - fp.stars.spread) * t;
  sp.stars.jitter = fp.stars.jitter + (tp.stars.jitter - fp.stars.jitter) * t;
  sp.curl.amplitude = fp.curl.amplitude + (tp.curl.amplitude - fp.curl.amplitude) * t;
  sp.curl.frequency = fp.curl.frequency + (tp.curl.frequency - fp.curl.frequency) * t;

  const fc = fp.colors;
  const tc = tp.colors;
  const sc = sp.colors;
  sc.core = lerpColor(fc.core, tc.core, t);
  sc.ring = lerpColor(fc.ring, tc.ring, t);
  sc.spine = lerpColor(fc.spine, tc.spine, t);
  sc.barb = lerpColor(fc.barb, tc.barb, t);
  sc.star = lerpColor(fc.star, tc.star, t);
  sc.dust = lerpColor(fc.dust, tc.dust, t);

  scratch.core.x = from.core.x + (plume.core.x - from.core.x) * t;
  scratch.core.y = from.core.y + (plume.core.y - from.core.y) * t;
  scratch.core.r = from.core.r + (plume.core.r - from.core.r) * t;

  return scratch;
}

// ── render ───────────────────────────────────────────────

/** 星星远景压暗系数（烘焙 alpha 0.35-0.9 → 屏上 ~0.25-0.6） */
const STAR_ALPHA_SCALE = 0.67;
/** 光照叠加层不透明度：低于 1 让下层陨石坑透出来 */
const LIGHTING_ALPHA = 0.75;
/** 羽枝相对整根羽毛的透明度折减 */
const BARB_ALPHA_SCALE = 0.3;
/** 表面纹理叠加不透明度：soft-light 低透明度，让陨石坑与光照透出 */
export const SURFACE_TEXTURE_ALPHA = 0.3;

/**
 * 星球表面纹理叠加：soft-light 混合，alpha 可按 morph 进度缩放。
 * 调用方需已 clip 进星球圆盘；surface 为 null 或权重 ≈ 0 时静默跳过。
 */
export function drawPlanetSurfaceOverlay(
  ctx: PlumeDrawContext,
  core: { x: number; y: number; r: number },
  surface: HTMLCanvasElement | null,
  alphaScale = 1
): void {
  if (!surface) return;
  const alpha = SURFACE_TEXTURE_ALPHA * alphaScale;
  if (alpha <= 0.001) return;
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "soft-light";
  ctx.drawImage(surface, core.x - core.r, core.y - core.r, core.r * 2, core.r * 2);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

// ── 颜色工具：参数色板保持 hex（lerpColor 约束），渲染期派生 rgb/rgba ──

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function lighten(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.round(r + (255 - r) * k)},${Math.round(g + (255 - g) * k)},${Math.round(
    b + (255 - b) * k
  )})`;
}

function darken(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.round(r * (1 - k))},${Math.round(g * (1 - k))},${Math.round(b * (1 - k))})`;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 绘制一帧（每次 invalidation 调用一次，事件驱动，非常驻 loop）。
 * 三层绘制顺序：
 *   远景 stars（halo 加法光晕 + dot/sparkle4/star5 形状）
 *   → 中景 星球（大气光晕 → 轨道后半弧 → clip 圆内本体[底色→陨石坑→表面纹理→光照→高光] → 轨道前半弧）
 *   → 前景 feathers（羽片剪影 → 羽轴 → 羽枝线，压在星球之上）
 * s ∈ [0,1] 为 hero → header 滚动进度；语义减法顺序：
 * stars/dust → outer barbs → inner barbs → secondary orbit → spine；星球永不消失。
 */
export function drawOrbitalPlume(
  ctx: PlumeDrawContext,
  plume: PreparedPlume,
  s: number,
  morph?: PlumeMorph,
  assets?: PlumeAssets
): void {
  const g = morph ? resolvePlumeMorph(plume, morph) : plume;
  const ch = g.channels;
  const colors = g.params.colors;
  const H = g.sceneH;
  const { x: cx, y: cy, r } = g.core;

  ctx.save();

  // ── 远景：星星（低 alpha + halo + 可辨认形状）──
  // 下滑过程中星星不发生动画：始终全量显示，不随 s 淡出
  const starEnv = 1;
  const starCount = g.starCount;
  if (starCount > 0) {
    for (let i = 0; i < starCount; i++) {
      const x = g.stars[i * 7];
      const y = g.stars[i * 7 + 1];
      const sr = g.stars[i * 7 + 2];
      const alpha = g.stars[i * 7 + 3];
      const rotation = g.stars[i * 7 + 4];
      const halo = g.stars[i * 7 + 5];
      const aspect = g.stars[i * 7 + 6];
      const kind = g.starKinds[i];

      // 大星光晕：径向渐变 + 加法混合
      if (halo > 1.5) {
        const hr = sr * halo;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, hr);
        grad.addColorStop(0, withAlpha(colors.star, alpha * 0.5));
        grad.addColorStop(1, withAlpha(colors.star, 0));
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = grad;
        ctx.fillRect(x - hr, y - hr, hr * 2, hr * 2);
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.scale(aspect, 1);
      ctx.globalAlpha = alpha * STAR_ALPHA_SCALE;
      ctx.fillStyle = colors.star;
      ctx.beginPath();
      if (kind === 0) {
        ctx.arc(0, 0, sr, 0, TAU);
      } else if (kind === 1) {
        // sparkle4：四角星，8 顶点长短交替（长=r，短=r*0.3）
        for (let j = 0; j < 8; j++) {
          const a = (j * Math.PI) / 4;
          const rad = j % 2 === 0 ? sr : sr * 0.3;
          const px = Math.cos(a) * rad;
          const py = Math.sin(a) * rad;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else {
        // star5：五角星，10 顶点外内交替（外=r，内=r*0.4）
        for (let j = 0; j < 10; j++) {
          const a = (j * Math.PI) / 5;
          const rad = j % 2 === 0 ? sr : sr * 0.4;
          const px = Math.cos(a) * rad;
          const py = Math.sin(a) * rad;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ── 中景：星球大气光晕（ring 色径向渐变，加法混合发光）──
  const atmosphere = g.params.planet.atmosphere;
  if (atmosphere > 0.01) {
    const haloR = r * 1.7;
    const grad = ctx.createRadialGradient(cx, cy, r, cx, cy, haloR);
    grad.addColorStop(0, withAlpha(colors.ring, atmosphere * 0.3));
    grad.addColorStop(1, withAlpha(colors.ring, 0));
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
    ctx.globalCompositeOperation = "source-over";
  }

  // ── 轨道后半弧（星球背后，角度 0 → π）──
  // 下滑过程中轨道不发生动画：始终全量显示
  const orbitEnv = 1;
  const nOrbit = g.density.orbitSamples;
  const halfOrbit = Math.floor(nOrbit / 2);
  if (orbitEnv >= 0.01 && nOrbit > 1) {
    ctx.globalAlpha = orbitEnv;
    ctx.strokeStyle = colors.dust;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.orbit[0], g.orbit[1]);
    for (let i = 1; i <= halfOrbit; i++) ctx.lineTo(g.orbit[i * 2], g.orbit[i * 2 + 1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── 星球本体（clip 圆：底色 → 陨石坑 → 光照渐变 → 高光）──
  const lightAngle = g.params.planet.lightAngle;
  const craterCount = g.density.craterCount;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();

  // 底色
  ctx.fillStyle = colors.core;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  // 陨石坑：深心 → 亮沿径向渐变，depth 调制 alpha
  for (let ci = 0; ci < craterCount; ci++) {
    const nx = g.craters[ci * 4];
    const ny = g.craters[ci * 4 + 1];
    const cr = g.craters[ci * 4 + 2] * r;
    const depth = g.craters[ci * 4 + 3];
    const px = cx + nx * r;
    const py = cy + ny * r;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, cr);
    grad.addColorStop(0, darken(colors.core, 0.3));
    grad.addColorStop(1, lighten(colors.core, 0.1));
    ctx.globalAlpha = depth;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, cr, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 表面纹理：soft-light 低透明度叠加（WebGL 不可用时 assets.surface 为 null，自动跳过）
  drawPlanetSurfaceOverlay(ctx, g.core, assets?.surface ?? null);

  // 光照渐变：亮侧 lighten → 暗侧 darken，半透明叠加让陨石坑透出
  ctx.globalCompositeOperation = "source-over";
  const lx = cx + Math.cos(lightAngle) * r * 0.5;
  const ly = cy + Math.sin(lightAngle) * r * 0.5;
  const lightGrad = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 2);
  lightGrad.addColorStop(0, lighten(colors.core, 0.55));
  lightGrad.addColorStop(1, darken(colors.core, 0.55));
  ctx.globalAlpha = LIGHTING_ALPHA;
  ctx.fillStyle = lightGrad;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.globalAlpha = 1;

  // 高光点：亮侧软边圆
  const hx = cx + Math.cos(lightAngle) * r * 0.55;
  const hy = cy + Math.sin(lightAngle) * r * 0.55;
  const hr = r * 0.25;
  const hiGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
  hiGrad.addColorStop(0, "rgba(255,255,255,0.6)");
  hiGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hiGrad;
  ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);

  ctx.restore();

  // ── 轨道前半弧（星球前面，角度 π → 2π）──
  if (orbitEnv >= 0.01 && nOrbit > 1) {
    ctx.globalAlpha = orbitEnv;
    ctx.strokeStyle = colors.dust;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.orbit[halfOrbit * 2], g.orbit[halfOrbit * 2 + 1]);
    for (let i = halfOrbit + 1; i < nOrbit; i++) {
      ctx.lineTo(g.orbit[i * 2], g.orbit[i * 2 + 1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── 前景：羽毛（羽片剪影 → 羽轴 → 羽枝线，压在星球之上）──
  // 下滑过程中羽毛不发生动画：始终全量显示，不随 s 淡出或漂移。
  // 位置 = 烘焙基础位置 + featherDrift（恒定偏移，由 route morph 驱动变化）
  const spineEnv = 1;
  const K = g.density.featherCount;
  const samples = g.density.spineSamples;
  if (spineEnv >= 0.01 && K > 0 && samples > 1) {
    const fp = g.params.feathers;
    const halfWidth = fp.width * H;
    const taper = fp.taper;
    const barbsPerSide = g.density.barbsPerSide;
    // 羽枝始终全量显示（不随 s 做 outer/inner 语义减法）
    const outerEnv = 1;
    const innerEnv = 1;
    const perFeather = Math.ceil(barbsPerSide / K);

    ctx.globalAlpha = spineEnv;

    for (let k = 0; k < K; k++) {
      const base = k * samples;
      const rootIdx = base * 2;
      // 漂移为恒定偏移（不随 scroll s 变化），route morph 时 featherDrift 插值产生飘逸感
      const dx = g.featherDrift[k * 2];
      const dy = g.featherDrift[k * 2 + 1];
      const rootX = g.spine[rootIdx] + dx;
      const rootY = g.spine[rootIdx + 1] + dy;
      const tipIdx = (base + samples - 1) * 2;
      const tipX = g.spine[tipIdx] + dx;
      const tipY = g.spine[tipIdx + 1] + dy;

      // 羽片剪影：左缘 root→tip 偏移 +N，右缘 tip→root 偏移 -N，闭合填充
      const vaneGrad = ctx.createLinearGradient(rootX, rootY, tipX, tipY);
      vaneGrad.addColorStop(0, withAlpha(colors.barb, 0.8));
      vaneGrad.addColorStop(1, withAlpha(colors.barb, 0));
      ctx.fillStyle = vaneGrad;
      ctx.beginPath();
      for (let i = 0; i < samples; i++) {
        const u = i / (samples - 1);
        const w = halfWidth * Math.pow(Math.sin(Math.PI * u), taper);
        const idx = (base + i) * 2;
        const px = g.spine[idx] + g.spineN[idx] * w + dx;
        const py = g.spine[idx + 1] + g.spineN[idx + 1] * w + dy;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      for (let i = samples - 1; i >= 0; i--) {
        const u = i / (samples - 1);
        const w = halfWidth * Math.pow(Math.sin(Math.PI * u), taper);
        const idx = (base + i) * 2;
        const px = g.spine[idx] - g.spineN[idx] * w + dx;
        const py = g.spine[idx + 1] - g.spineN[idx + 1] * w + dy;
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      // 羽轴：脊线描边
      ctx.strokeStyle = colors.spine;
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(rootX, rootY);
      for (let i = 1; i < samples; i++) {
        const idx = (base + i) * 2;
        ctx.lineTo(g.spine[idx] + dx, g.spine[idx + 1] + dy);
      }
      ctx.stroke();
    }

    // 羽枝线：低 alpha 细描，按到羽毛中点的归一化距离做 outer/inner 语义减法。
    // barbs 存储为 side-major（bi = side * barbsPerSide + i，i 按 k = i % K 轮询羽毛），
    // 与 prepare 布局一致；j = floor(i / K) 给出沿羽毛的序号。
    // 漂移按所属羽毛的 featherDrift 同步偏移。
    if (barbsPerSide > 0) {
      ctx.globalAlpha = spineEnv * BARB_ALPHA_SCALE;
      ctx.strokeStyle = colors.barb;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      let visible = 0;
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < barbsPerSide; i++) {
          const j = Math.floor(i / K);
          const u = (j + 0.5) / perFeather;
          const d = Math.abs(u - 0.5) * 2;
          const env = d > 0.5 ? outerEnv : innerEnv;
          if (d > env) continue;
          const k = i % K;
          // 羽枝漂移与所属羽毛同步，恒定偏移（不随 scroll s 变化）
          const bdx = g.featherDrift[k * 2];
          const bdy = g.featherDrift[k * 2 + 1];
          const bi = (side * barbsPerSide + i) * 4;
          ctx.moveTo(g.barbs[bi] + bdx, g.barbs[bi + 1] + bdy);
          ctx.lineTo(g.barbs[bi + 2] + bdx, g.barbs[bi + 3] + bdy);
          visible++;
        }
      }
      if (visible > 0) ctx.stroke();
      ctx.globalAlpha = spineEnv;
    }

    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

// ── 画框 chrome（与旧 sceneState 的 feather/radius 公式一致） ──

export interface PlumeChrome {
  feather: number;
  radius: number;
}

export function plumeChrome(s: number): PlumeChrome {
  return {
    feather: 80 * (1 - smoothstep(s, 0.6, 0.9)),
    radius: 2 * smoothstep(s, 0.7, 1),
  };
}
