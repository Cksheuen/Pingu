// planetTexture：WebGL 生成星球表面噪声纹理（fBm + domain warp）。
// 浏览器侧懒加载并按 seed/surfaceType/baseHex 缓存；
// Node、无 WebGL、着色器编译失败等任何异常一律静默降级返回 null。
//
// 产物为 2D canvas（WebGL 渲染后立即拷贝），避免缓存长期占用 GL context；
// 消费方用 drawImage 叠加，见 orbitalPlume.drawPlanetSurfaceOverlay。

export type PlanetSurfaceType = 0 | 1; // 0=rocky 1=banded

const TEXTURE_SIZE = 256;

const surfaceCache = new Map<string, HTMLCanvasElement>();

/** 缓存键：seed + surfaceType + baseHex 唯一确定一张纹理 */
export function planetSurfaceCacheKey(seed: number, surfaceType: number, baseHex: string): string {
  return `${seed}-${surfaceType}-${baseHex}`;
}

/** 星球表面类型：bands > 0 → 带状，否则岩质 */
export function planetSurfaceType(bands: number): PlanetSurfaceType {
  return bands > 0 ? 1 : 0;
}

function isValidHex(hex: string): boolean {
  return /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(hex);
}

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 不带 precision 行：按设备能力动态选择 highp / mediump
const FRAG_BODY = `
uniform float uSeed;
uniform int uSurfaceType;
uniform vec3 uBaseColor;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = vUv * 3.0 + uSeed * 10.0;
  // domain warp：两层 fBm 位移场
  vec2 q = vec2(fbm(p + uSeed * 7.0), fbm(p + vec2(5.2, 1.3) - uSeed * 3.0));
  vec2 r = vec2(
    fbm(p + 4.0 * q + vec2(1.7, 9.2)),
    fbm(p + 4.0 * q + vec2(8.3, 2.8))
  );
  float f = fbm(p + 4.0 * r);

  vec3 color;
  if (uSurfaceType == 1) {
    // 带状：沿纬度的条纹被 warp 场扰动
    float band = sin((vUv.y + r.x * 0.25) * 18.0 + uSeed * 40.0) * 0.5 + 0.5;
    float shade = mix(0.72, 1.18, band);
    color = uBaseColor * shade * (0.85 + 0.3 * f);
  } else {
    // 岩质：灰蓝斑块，明暗由 fBm 调制
    float shade = mix(0.68, 1.22, f);
    vec3 rocky = mix(uBaseColor, vec3(0.55, 0.62, 0.72), 0.35);
    color = rocky * shade;
  }
  gl_FragColor = vec4(color, 1.0);
}`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * 实际生成纹理：WebGL2 优先，降级 WebGL1；渲染后拷贝到 2D canvas 并释放 GL context。
 * 任何失败返回 null（调用方静默降级）。
 */
function createSurface(
  seed: number,
  surfaceType: PlanetSurfaceType,
  baseHex: string
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;

  let glCanvas: HTMLCanvasElement;
  try {
    glCanvas = document.createElement("canvas");
    glCanvas.width = TEXTURE_SIZE;
    glCanvas.height = TEXTURE_SIZE;
  } catch {
    return null;
  }

  let gl: WebGLRenderingContext | null = null;
  try {
    gl =
      (glCanvas.getContext("webgl2") as WebGLRenderingContext | null) ??
      (glCanvas.getContext("webgl") as WebGLRenderingContext | null);
  } catch {
    gl = null;
  }
  if (!gl) return null;

  try {
    // highp 不可用的老设备降级 mediump（uSeed 已归一化到 [0,1)，精度损失可接受）
    let precision = "highp";
    try {
      const fmt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      if (!fmt || fmt.rangeMin === 0) precision = "mediump";
    } catch {
      precision = "mediump";
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, `precision ${precision} float;${FRAG_BODY}`);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // seed 归一化到 [0,1)，避免 mediump 下大整数偏移混叠
    const seed01 = (Math.abs(Math.trunc(seed)) % 997) / 997;
    gl.uniform1f(gl.getUniformLocation(prog, "uSeed"), seed01);
    gl.uniform1i(gl.getUniformLocation(prog, "uSurfaceType"), surfaceType);
    const [r, g, b] = hexToRgb01(baseHex);
    gl.uniform3f(gl.getUniformLocation(prog, "uBaseColor"), r, g, b);

    gl.viewport(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 拷贝到 2D canvas：GL canvas 仅作中转，随后释放 context（浏览器 GL context 数量有限）
    const out = document.createElement("canvas");
    out.width = TEXTURE_SIZE;
    out.height = TEXTURE_SIZE;
    const outCtx = out.getContext("2d");
    if (!outCtx) return null;
    outCtx.drawImage(glCanvas, 0, 0);

    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();

    return out;
  } catch {
    return null;
  }
}

/**
 * 获取星球表面纹理（模块级缓存，浏览器侧懒加载）。
 * 缓存键：seed + surfaceType + baseHex；任何失败（Node / 无 WebGL / 参数非法）返回 null。
 */
export function getPlanetSurface(
  seed: number,
  surfaceType: number,
  baseHex: string
): HTMLCanvasElement | null {
  if (!Number.isFinite(seed)) return null;
  if (surfaceType !== 0 && surfaceType !== 1) return null;
  if (typeof baseHex !== "string" || !isValidHex(baseHex)) return null;

  const key = planetSurfaceCacheKey(seed, surfaceType, baseHex);
  const cached = surfaceCache.get(key);
  if (cached) return cached;

  const canvas = createSurface(seed, surfaceType as PlanetSurfaceType, baseHex);
  if (canvas) surfaceCache.set(key, canvas);
  return canvas;
}
