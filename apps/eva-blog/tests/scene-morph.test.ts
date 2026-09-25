import test from "node:test";
import assert from "node:assert/strict";
import { renderScene, renderSceneMorph, sceneState } from "../src/lib/svgRenderer";
import type { Scene } from "../src/lib/svgRenderer";

// 与 orbit-scene.test.ts 同款的 mock ctx
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

// 两个同构但不同配色的场景（模拟路由切换）
function makeFromScene(): Scene {
  return {
    width: 900,
    height: 640,
    elements: [
      { kind: "rect", x: 0, y: 0, w: 900, h: 640, fill: "#e9edf0" },
      { kind: "path", d: "M84 506C188 266 368 108 712 128", stroke: "#26374d", width: 8, dash: null, length: 900, samples: [{ x: 84, y: 506 }, { x: 712, y: 128 }] },
      { kind: "path", d: "M142 540C278 330 492 204 780 246", stroke: "#4d72cf", width: 3, dash: [8, 16], length: 900 },
      { kind: "circle", cx: 476, cy: 252, r: 112, fill: "none", stroke: "#69c9d8", width: 12, ride: false },
      { kind: "circle", cx: 476, cy: 252, r: 28, fill: "#314f9b", stroke: "none", width: 1, ride: false },
      { kind: "circle", cx: 666, cy: 184, r: 15, fill: "#d46b61", stroke: "none", width: 1, ride: true },
      { kind: "text", x: 110, y: 600, text: "ORBIT / 01", fontFamily: "monospace", size: 18, letterSpacing: "4", fill: "#26374d" },
    ],
  };
}

function makeToScene(): Scene {
  return {
    width: 900,
    height: 640,
    elements: [
      { kind: "rect", x: 0, y: 0, w: 900, h: 640, fill: "#f0e8d7" },
      { kind: "path", d: "M96 472C210 250 384 128 700 146", stroke: "#2b3a55", width: 8, dash: null, length: 900, samples: [{ x: 96, y: 472 }, { x: 700, y: 146 }] },
      { kind: "path", d: "M150 508C292 306 500 206 772 246", stroke: "#b3402f", width: 3, dash: [8, 16], length: 900 },
      { kind: "circle", cx: 468, cy: 258, r: 108, fill: "none", stroke: "#69c9d8", width: 12, ride: false },
      { kind: "circle", cx: 468, cy: 258, r: 26, fill: "#314f9b", stroke: "none", width: 1, ride: false },
      { kind: "circle", cx: 652, cy: 182, r: 15, fill: "#d46b61", stroke: "none", width: 1, ride: true },
      { kind: "text", x: 118, y: 600, text: "GRID MEMORY / 02", fontFamily: "monospace", size: 18, letterSpacing: "4", fill: "#2b3a55" },
    ],
  };
}

const DEST = { x: 0, y: 0, w: 1440, h: 800 };

test("renderSceneMorph t=0 与 renderScene(from) 产生相同绘制调用", () => {
  const from = makeFromScene();
  const to = makeToScene();

  const { ctx: ctxMorph, calls: callsMorph } = makeCtx();
  renderSceneMorph(ctxMorph, from, to, 0, 1, DEST);

  const { ctx: ctxDirect, calls: callsDirect } = makeCtx();
  const st = sceneState(from, 1);
  renderScene(ctxDirect, from, st, DEST);

  // 调用数量应一致
  assert.equal(callsMorph.length, callsDirect.length, "morph t=0 应与直接渲染产生相同数量的调用");
  // 调用类型序列应一致
  const morphNames = callsMorph.map((c) => c[0]);
  const directNames = callsDirect.map((c) => c[0]);
  assert.deepEqual(morphNames, directNames, "morph t=0 调用序列应与直接渲染一致");
});

test("renderSceneMorph t=1 与 renderScene(to) 产生相同绘制调用", () => {
  const from = makeFromScene();
  const to = makeToScene();

  const { ctx: ctxMorph, calls: callsMorph } = makeCtx();
  renderSceneMorph(ctxMorph, from, to, 1, 1, DEST);

  const { ctx: ctxDirect, calls: callsDirect } = makeCtx();
  const st = sceneState(to, 1);
  renderScene(ctxDirect, to, st, DEST);

  assert.equal(callsMorph.length, callsDirect.length, "morph t=1 应与直接渲染产生相同数量的调用");
  const morphNames = callsMorph.map((c) => c[0]);
  const directNames = callsDirect.map((c) => c[0]);
  assert.deepEqual(morphNames, directNames, "morph t=1 调用序列应与直接渲染一致");
});

test("renderSceneMorph t=0 颜色与 from 一致", () => {
  const from = makeFromScene();
  const to = makeToScene();
  const { ctx } = makeCtx();
  renderSceneMorph(ctx, from, to, 0, 1, DEST);
  // 最后一个 stroke 来自 ring circle，最后一个 fill 来自 text
  // lerpColor 始终返回 rgb() 格式
  assert.equal(ctx.strokeStyle, "rgb(105,201,216)", "ring stroke 应为 from 的 #69c9d8");
  assert.equal(ctx.fillStyle, "rgb(38,55,77)", "text fill 应为 from 的 #26374d");
});

test("renderSceneMorph t=1 颜色与 to 一致", () => {
  const from = makeFromScene();
  const to = makeToScene();
  const { ctx } = makeCtx();
  renderSceneMorph(ctx, from, to, 1, 1, DEST);
  assert.equal(ctx.strokeStyle, "rgb(105,201,216)", "ring stroke 应为 to 的 #69c9d8");
  assert.equal(ctx.fillStyle, "rgb(43,58,85)", "text fill 应为 to 的 #2b3a55");
});

test("renderSceneMorph t=0.5 颜色为中间值", () => {
  const from = makeFromScene();
  const to = makeToScene();
  const { ctx } = makeCtx();
  renderSceneMorph(ctx, from, to, 0.5, 1, DEST);
  // from ring stroke #69c9d8 = rgb(105,201,216), to ring stroke #69c9d8 = rgb(105,201,216) → 相同
  assert.equal(ctx.strokeStyle, "rgb(105,201,216)", "ring stroke 两端相同，插值不变");
  // from text fill #26374d = rgb(38,55,77), to text fill #2b3a55 = rgb(43,58,85)
  // mid = rgb(40.5, 56.5, 81) → rgb(41,57,81)（四舍五入）
  assert.equal(ctx.fillStyle, "rgb(41,57,81)", "text fill 应为中间值");
});

test("renderSceneMorph 不修改 from/to 场景", () => {
  const from = makeFromScene();
  const to = makeToScene();
  const fromSnapshot = JSON.parse(JSON.stringify(from));
  const toSnapshot = JSON.parse(JSON.stringify(to));
  const { ctx } = makeCtx();
  renderSceneMorph(ctx, from, to, 0.5, 1, DEST);
  assert.deepEqual(from, fromSnapshot, "from 场景不被修改");
  assert.deepEqual(to, toSnapshot, "to 场景不被修改");
});

test("renderSceneMorph 几何插值：t=0.5 时 circle 位置为中点", () => {
  const from = makeFromScene();
  const to = makeToScene();
  const { ctx, calls } = makeCtx();
  renderSceneMorph(ctx, from, to, 0.5, 0, DEST);
  // 找到 arc 调用（circle 绘制），检查圆心是否为插值
  // from ring: cx=476, cy=252; to ring: cx=468, cy=258
  // mid: cx=472, cy=255
  const arcCalls = calls.filter((c) => c[0] === "arc");
  assert.ok(arcCalls.length >= 3, "应至少有 3 个 arc 调用（ring + dot + ride）");
  // ring 是第一个 arc（在 ride 之前）
  const ringArc = arcCalls[0];
  assert.ok(Math.abs((ringArc[1] as number) - 472) < 0.01, `ring cx 应为 472，实际 ${ringArc[1]}`);
  assert.ok(Math.abs((ringArc[2] as number) - 255) < 0.01, `ring cy 应为 255，实际 ${ringArc[2]}`);
});
