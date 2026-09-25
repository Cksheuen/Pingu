// liquidMorph：纯插值工具，用于路由切换时的场景连续变形。
// 所有函数无副作用、无 DOM 依赖，可在 Node 中单元测试。

// ── 颜色插值 ─────────────────────────────────────────────

const rgbCache = new Map<string, [number, number, number]>();

function hexToRgb(hex: string): [number, number, number] {
  const cached = rgbCache.get(hex);
  if (cached) return cached;
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16);
  const rgb: [number, number, number] = [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  rgbCache.set(hex, rgb);
  return rgb;
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// ── 路径 d 插值 ──────────────────────────────────────────

interface PathToken {
  cmd: string;
  args: number[];
}

// 将 SVG path d 字符串分解为命令+数值参数
export function tokenizePath(d: string): PathToken[] {
  const tokens: PathToken[] = [];
  // 匹配命令字母或数字（含负号、小数点）
  const parts = d.match(/[a-zA-Z]|-?\d+\.?\d*/g);
  if (!parts) return tokens;
  let i = 0;
  while (i < parts.length) {
    const cmd = parts[i];
    if (/[a-zA-Z]/.test(cmd)) {
      const args: number[] = [];
      i++;
      while (i < parts.length && !/[a-zA-Z]/.test(parts[i])) {
        args.push(parseFloat(parts[i]));
        i++;
      }
      tokens.push({ cmd, args });
    } else {
      // 没有命令前缀的数值（理论上不应该出现）
      i++;
    }
  }
  return tokens;
}

// 检查两条路径的命令骨架是否一致（相同命令序列、相同参数数量）
export function pathTopologyCompatible(a: string, b: string): boolean {
  const ta = tokenizePath(a);
  const tb = tokenizePath(b);
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    if (ta[i].cmd !== tb[i].cmd) return false;
    if (ta[i].args.length !== tb[i].args.length) return false;
  }
  return true;
}

// 数值插值两条路径。如果命令骨架不一致，返回 compatible: false。
export function lerpPathD(a: string, b: string, t: number): { d: string; compatible: boolean } {
  if (!pathTopologyCompatible(a, b)) {
    return { d: t < 0.5 ? a : b, compatible: false };
  }
  const ta = tokenizePath(a);
  const tb = tokenizePath(b);
  const parts: string[] = [];
  for (let i = 0; i < ta.length; i++) {
    parts.push(ta[i].cmd);
    for (let j = 0; j < ta[i].args.length; j++) {
      const v = ta[i].args[j] + (tb[i].args[j] - ta[i].args[j]) * t;
      // 保留合理精度，避免浮点噪声
      parts.push(Math.round(v * 100) / 100 + "");
    }
  }
  return { d: parts.join(" "), compatible: true };
}
