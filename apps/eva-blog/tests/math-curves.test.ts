import test from "node:test";
import assert from "node:assert/strict";
import { createMathCurves, drawMathCurves, curveEnvelope } from "../src/lib/mathCurves";

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
