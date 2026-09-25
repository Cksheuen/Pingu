import test from "node:test";
import assert from "node:assert/strict";
import { createMathCurves, drawMathCurves, curveEnvelope, DEFAULT_TUNING } from "../src/lib/mathCurves";

// 与 orbit-scene.test.mjs 同款的 mock ctx：记录调用、允许属性赋值
function makeCtx(): { ctx: CanvasRenderingContext2D; calls: Array<Array<string | symbol | unknown>> } {
  const calls: Array<Array<string | symbol | unknown>> = [];
  const recorded: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(
    recorded,
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => calls.push([prop, ...args]);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

test("curveEnvelope 首为 1、尾为 0（由多到少的可见性边界）", () => {
  assert.equal(curveEnvelope(0), 1);
  assert.equal(curveEnvelope(1), 0);
  assert.ok(curveEnvelope(0.5) > 0.9); // 中段仍然可见
  assert.ok(curveEnvelope(0.95) < 0.01); // 末段早退
});

test("createMathCurves 预计算数据结构与长度正确", () => {
  const curves = createMathCurves();
  assert.ok(curves.harmonograph instanceof Float32Array);
  assert.ok(curves.flowField instanceof Float32Array);
  assert.ok(curves.spiral instanceof Float32Array);
  assert.equal(curves.harmonograph.length, 500 * 2);
  assert.equal(curves.flowField.length, 64 * 120 * 2);
  assert.equal(curves.spiral.length, 200 * 2);
  // Lissajous 实时计算，仅保留参数
  assert.equal(curves.lissajous.samples, 300);
  assert.equal(curves.lissajous.a, 3);
  assert.equal(curves.lissajous.b, 4);
});

test("预计算是确定性的：两次创建结果逐位一致", () => {
  const a = createMathCurves();
  const b = createMathCurves();
  assert.deepEqual(Array.from(a.harmonograph), Array.from(b.harmonograph));
  assert.deepEqual(Array.from(a.flowField), Array.from(b.flowField));
  assert.deepEqual(Array.from(a.spiral), Array.from(b.spiral));
});

test("Harmonograph 首点：t=0 时 x=sin(π/4)、y=1+sin(3π/4) 映射到场景坐标", () => {
  const { harmonograph } = createMathCurves();
  const x0 = Math.SQRT1_2 * 300 + 450;
  const y0 = (1 + Math.SQRT1_2) * 200 + 320;
  assert.ok(Math.abs(harmonograph[0] - x0) < 1e-4);
  assert.ok(Math.abs(harmonograph[1] - y0) < 1e-4);
  // 阻尼收敛：末点（t=20）应贴近场景中心
  const last = harmonograph.length - 2;
  assert.ok(Math.abs(harmonograph[last] - 450) < 1);
  assert.ok(Math.abs(harmonograph[last + 1] - 320) < 1);
});

test("Spiral 起点在中心、终点在 θ=4π 处（r=60π，方向 +x）", () => {
  const { spiral } = createMathCurves();
  assert.ok(Math.abs(spiral[0] - 450) < 1e-4);
  assert.ok(Math.abs(spiral[1] - 320) < 1e-4);
  const last = spiral.length - 2;
  assert.ok(Math.abs(spiral[last] - (450 + 60 * Math.PI)) < 1e-3);
  assert.ok(Math.abs(spiral[last + 1] - 320) < 1e-3);
});

test("FlowField 初始位置均匀分布在 900×640 场景内且确定", () => {
  const { flowField } = createMathCurves();
  for (let p = 0; p < 64; p++) {
    const base = p * 120 * 2;
    assert.ok(flowField[base] >= 0 && flowField[base] <= 900);
    assert.ok(flowField[base + 1] >= 0 && flowField[base + 1] <= 640);
  }
  // 轨迹第 1 步相对起点发生位移（流场非平凡）
  const base = 0;
  const moved =
    Math.abs(flowField[base + 2] - flowField[base]) > 0 ||
    Math.abs(flowField[base + 3] - flowField[base + 1]) > 0;
  assert.ok(moved);
});

test("drawMathCurves 首屏全部绘制、终态早退（s=1 不产生任何绘制）", () => {
  const curves = createMathCurves();
  // s=0：全部曲线可见
  const { ctx: ctx0, calls: calls0 } = makeCtx();
  drawMathCurves(ctx0, curves, 0);
  assert.ok(calls0.length > 0, "s=0 应有绘制调用");
  // s=1：包络为 0，早退
  const { ctx: ctx1, calls: calls1 } = makeCtx();
  drawMathCurves(ctx1, curves, 1);
  assert.equal(calls1.length, 0, "s=1 不应有绘制调用");
});

test("drawMathCurves 首屏（s=0.1）绘制全部 4 种曲线，save/restore 平衡", () => {
  const curves = createMathCurves();
  const { ctx, calls } = makeCtx();
  drawMathCurves(ctx, curves, 0.1);

  const names = calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === "save").length, 1);
  assert.equal(names.filter((n) => n === "restore").length, 1);
  assert.equal(ctx.globalAlpha, 1); // 包络首段为 1
  // 折线 ×2（harmonograph + spiral）、虚线 lissajous、64 粒子圆点
  assert.equal(names.filter((n) => n === "stroke").length, 3);
  assert.equal(names.filter((n) => n === "arc").length, 64);
  assert.equal(names.filter((n) => n === "fill").length, 64);
  // Lissajous 虚线样式
  const dashCall = calls.find((c) => c[0] === "setLineDash" && Array.isArray(c[1]));
  assert.ok(dashCall, "应存在 setLineDash 调用");
  assert.deepEqual(dashCall[1], [8, 16]);
});

test("drawMathCurves 中段（s=0.5）曲线减少：harmonograph 已消失，粒子数减少", () => {
  const curves = createMathCurves();
  const { ctx, calls } = makeCtx();
  drawMathCurves(ctx, curves, 0.5);

  const names = calls.map((c) => c[0]);
  // harmonograph 在 s=0.45 时已完全消失，只剩 lissajous + spiral
  assert.ok(names.filter((n) => n === "stroke").length <= 2, "s=0.5 时最多 2 条曲线");
  // 粒子数从 64 减少到约 20
  const arcCount = names.filter((n) => n === "arc").length;
  assert.ok(arcCount < 64, `s=0.5 时粒子数应减少：${arcCount} < 64`);
  assert.ok(arcCount > 0, "s=0.5 时仍应有粒子");
});

test("drawMathCurves 粒子数随 s 递减（由多到少）", () => {
  const curves = createMathCurves();
  const countAt = (s: number) => {
    const { ctx, calls } = makeCtx();
    drawMathCurves(ctx, curves, s, 900, 640);
    return calls.filter((call) => call[0] === "arc").length;
  };
  const early = countAt(0.1);
  const mid = countAt(0.4);
  const late = countAt(0.7);
  assert.equal(early, 64, "s=0.1 时全部 64 个粒子可见");
  assert.ok(mid < early, `s=0.4 时粒子数应减少：${mid} < ${early}`);
  assert.ok(late < mid, `s=0.7 时粒子数应更少：${late} < ${mid}`);
  assert.equal(late, 0, "s=0.7 时粒子应全部消失");
});

// ── 参数化测试 ───────────────────────────────────────────

test("createMathCurves 默认参数与 900×640 一致", () => {
  const def = createMathCurves();
  const explicit = createMathCurves(900, 640);
  assert.deepEqual(Array.from(def.harmonograph), Array.from(explicit.harmonograph));
  assert.deepEqual(Array.from(def.flowField), Array.from(explicit.flowField));
  assert.deepEqual(Array.from(def.spiral), Array.from(explicit.spiral));
  assert.equal(def.sceneW, 900);
  assert.equal(def.sceneH, 640);
});

test("createMathCurves 自定义尺寸：首点映射到新场景中心", () => {
  const curves = createMathCurves(800, 600);
  // Harmonograph t=0: x=sin(π/4), y=1+sin(3π/4)
  const x0 = Math.SQRT1_2 * (800 / 3) + 400;
  const y0 = (1 + Math.SQRT1_2) * (600 / 3.2) + 300;
  assert.ok(Math.abs(curves.harmonograph[0] - x0) < 1e-4);
  assert.ok(Math.abs(curves.harmonograph[1] - y0) < 1e-4);
  assert.equal(curves.sceneW, 800);
  assert.equal(curves.sceneH, 600);
});

test("createMathCurves 自定义颜色写入 colors 字段", () => {
  const curves = createMathCurves(900, 640, {
    colors: { harmonograph: "#ff0000", lissajous: "#00ff00", flowField: "#0000ff", spiral: "#ffffff" },
  });
  assert.equal(curves.colors.harmonograph, "#ff0000");
  assert.equal(curves.colors.lissajous, "#00ff00");
  assert.equal(curves.colors.flowField, "#0000ff");
  assert.equal(curves.colors.spiral, "#ffffff");
});

test("createMathCurves 自定义 Lissajous 参数", () => {
  const curves = createMathCurves(900, 640, {
    lissajous: { a: 5, b: 7, delta0: 1.5, k: 2.0 },
  });
  assert.equal(curves.lissajous.a, 5);
  assert.equal(curves.lissajous.b, 7);
  assert.equal(curves.lissajous.delta0, 1.5);
  assert.equal(curves.lissajous.k, 2.0);
  // samples 和 tMax 保持默认
  assert.equal(curves.lissajous.samples, 300);
});

test("createMathCurves 部分 tuning 合并默认值", () => {
  const curves = createMathCurves(900, 640, {
    colors: { harmonograph: "#ff0000" },
  });
  // 只覆盖了 harmonograph，其他保持默认
  assert.equal(curves.colors.harmonograph, "#ff0000");
  assert.equal(curves.colors.lissajous, DEFAULT_TUNING.colors.lissajous);
  assert.equal(curves.colors.flowField, DEFAULT_TUNING.colors.flowField);
  assert.equal(curves.colors.spiral, DEFAULT_TUNING.colors.spiral);
  // Lissajous 参数也保持默认
  assert.equal(curves.lissajous.a, DEFAULT_TUNING.lissajous.a);
});

// ── Morph 测试 ───────────────────────────────────────────

test("drawMathCurves morph t=0 与 from 曲线一致", () => {
  const from = createMathCurves(900, 640, {
    colors: { harmonograph: "#ff0000", lissajous: "#00ff00", flowField: "#0000ff", spiral: "#ffffff" },
  });
  const to = createMathCurves(900, 640);
  const { ctx: ctxMorph, calls: callsMorph } = makeCtx();
  drawMathCurves(ctxMorph, to, 0.1, undefined, undefined, { from, t: 0 });
  const { ctx: ctxFrom, calls: callsFrom } = makeCtx();
  drawMathCurves(ctxFrom, from, 0.1);
  // 调用序列应一致（相同的绘制命令数）
  assert.equal(callsMorph.length, callsFrom.length);
  // strokeStyle 最后被 spiral 设置，fillStyle 被 flowField 设置
  // lerpColor 始终返回 rgb() 格式，即使 t=0/1
  assert.equal(ctxMorph.strokeStyle, "rgb(255,255,255)", "spiral 颜色应为 from 的 #ffffff");
  assert.equal(ctxMorph.fillStyle, "rgb(0,0,255)", "flowField 颜色应为 from 的 #0000ff");
});

test("drawMathCurves morph t=1 与 to 曲线一致", () => {
  const from = createMathCurves(900, 640, {
    colors: { harmonograph: "#ff0000", lissajous: "#00ff00", flowField: "#0000ff", spiral: "#ffffff" },
  });
  const to = createMathCurves(900, 640);
  const { ctx } = makeCtx();
  drawMathCurves(ctx, to, 0.1, undefined, undefined, { from, t: 1 });
  assert.equal(ctx.strokeStyle, "rgb(38,55,77)", "spiral 颜色应为 to 的 #26374d");
  assert.equal(ctx.fillStyle, "rgb(212,107,97)", "flowField 颜色应为 to 的 #d46b61");
});

test("drawMathCurves morph t=0.5 颜色为中间值", () => {
  const from = createMathCurves(900, 640, {
    colors: { harmonograph: "#000000", lissajous: "#000000", flowField: "#000000", spiral: "#000000" },
  });
  const to = createMathCurves(900, 640, {
    colors: { harmonograph: "#ffffff", lissajous: "#ffffff", flowField: "#ffffff", spiral: "#ffffff" },
  });
  const { ctx } = makeCtx();
  drawMathCurves(ctx, to, 0.1, undefined, undefined, { from, t: 0.5 });
  // 黑色→白色 t=0.5 应为 rgb(128,128,128)
  assert.equal(ctx.strokeStyle, "rgb(128,128,128)", "spiral morph 颜色应为中间值");
  assert.equal(ctx.fillStyle, "rgb(128,128,128)", "flowField morph 颜色应为中间值");
});

test("drawMathCurves morph 后 scratch 被缓存", () => {
  const from = createMathCurves(900, 640);
  const to = createMathCurves(900, 640);
  const { ctx } = makeCtx();
  drawMathCurves(ctx, to, 0.1, undefined, undefined, { from, t: 0.5 });
  const scratch = to._scratch;
  assert.ok(scratch, "morph 后 scratch 被缓存");
  assert.ok(scratch.harmonograph instanceof Float32Array);
  assert.ok(scratch.flowField instanceof Float32Array);
  assert.ok(scratch.spiral instanceof Float32Array);
});

test("drawMathCurves morph 不修改 from/to 的原始数据", () => {
  const from = createMathCurves(900, 640);
  const to = createMathCurves(900, 640);
  const fromSnapshot = Array.from(from.harmonograph);
  const toSnapshot = Array.from(to.harmonograph);
  const { ctx } = makeCtx();
  drawMathCurves(ctx, to, 0.1, undefined, undefined, { from, t: 0.5 });
  assert.deepEqual(Array.from(from.harmonograph), fromSnapshot, "from 数据不被修改");
  assert.deepEqual(Array.from(to.harmonograph), toSnapshot, "to 数据不被修改");
});
