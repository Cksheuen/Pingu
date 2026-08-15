import test from "node:test";
import assert from "node:assert/strict";
import {
  coverTransform,
  sceneState,
  renderScene,
  ridePosition,
  easeOutCubic,
  smoothstep,
} from "../src/lib/svgRenderer";
import type { CircleSpec, Scene } from "../src/lib/svgRenderer";

// 0 与 -0 都视为归零（canvas translate(-0,-0) 与 translate(0,0) 等价）
const isZero = (x: number) => x === 0 || Object.is(x, -0);

// 与 sketch-orbit.svg 同构的最小场景（Node 无 DOMParser，手工构造）
function makeScene(): Scene {
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

test("coverTransform 与 object-fit: cover 的中心裁剪一致（方形目标 = brand mark）", () => {
  const t = coverTransform(900, 640, 100, 200, 40, 40);
  assert.ok(t, "coverTransform 应返回变换");
  assert.equal(t.sx, 130);
  assert.equal(t.sy, 0);
  assert.equal(t.sw, 640);
  assert.equal(t.sh, 640);
  assert.ok(Math.abs(t.scale - 40 / 640) < 1e-9);
});

test("coverTransform 宽屏目标上下裁剪（hero 状态）", () => {
  const t = coverTransform(900, 640, 0, 0, 1440, 800);
  assert.ok(t, "coverTransform 应返回变换");
  assert.equal(t.sx, 0);
  assert.equal(t.sw, 900);
  assert.equal(t.sh, 500);
  assert.equal(t.sy, 70);
  assert.ok(Math.abs(t.scale - 1.6) < 1e-9);
});

test("coverTransform 退化输入返回 null", () => {
  assert.equal(coverTransform(0, 640, 0, 0, 40, 40), null);
  assert.equal(coverTransform(900, 640, 0, 0, 0, 40), null);
});

test("sceneState 终态（s=1）与静态 brand-mark 一致：所有位移归零、背景不透明、无羽化", () => {
  const st = sceneState(makeScene(), 1);
  assert.equal(st.bgAlpha, 1);
  assert.equal(st.feather, 0);
  assert.equal(st.radius, 2);
  const [, solid, dashed, ring, dot, red, text] = st.elements;
  // 实线漂移归零
  assert.ok(isZero(solid.dx ?? 0));
  assert.ok(isZero(solid.dy ?? 0));
  // 虚线：漂移归零，行进量是周期 (8+16=24) 的整数倍
  assert.ok(isZero(dashed.dx ?? 0));
  assert.ok(isZero(dashed.dy ?? 0));
  assert.equal(dashed.march, 144);
  assert.equal(dashed.march % 24, 0);
  // 圆环呼吸归零、蓝点脉动归零
  assert.equal(ring.scale, 1);
  assert.equal(dot.scale, 1);
  // 红点回到静态位置
  assert.equal(red.travelT, 1);
  // 文字漂移归零
  assert.ok(isZero(text.dy ?? 0));
});

test("sceneState 初始态（s=0）：背景透明、所有元素静止在原始位置", () => {
  const st = sceneState(makeScene(), 0);
  assert.equal(st.bgAlpha, 0);
  assert.ok(st.feather > 79);
  assert.equal(st.radius, 0);
  const [, solid, dashed, ring, dot, red, text] = st.elements;
  assert.ok(isZero(solid.dx ?? 0));
  assert.ok(isZero(solid.dy ?? 0));
  assert.ok(isZero(dashed.dx ?? 0));
  assert.ok(isZero(dashed.dy ?? 0));
  assert.equal(dashed.march, 0);
  assert.equal(ring.scale, 1);
  assert.equal(dot.scale, 1);
  assert.equal(red.travelT, 0);
  assert.ok(isZero(text.dy ?? 0));
});

test("sceneState 中段（s=0.5）：元素有位移但未失真", () => {
  const st = sceneState(makeScene(), 0.5);
  const [, solid, , ring] = st.elements;
  // sin(0.5π) = 1，位移达到峰值
  assert.equal(solid.dx, 6);
  assert.equal(solid.dy, 10);
  assert.ok((ring.scale ?? 0) > 1);
});

test("ridePosition 终点回到静态位置，起点在轨道上", () => {
  const scene = makeScene();
  const red = scene.elements[5] as CircleSpec;
  const end = ridePosition(scene, 1, red);
  assert.equal(end.x, 666);
  assert.equal(end.y, 184);
  const start = ridePosition(scene, 0, red);
  assert.equal(start.x, 84);
  assert.equal(start.y, 506);
});

test("renderScene 以 cover 变换驱动 canvas，并逐元素绘制", () => {
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
  const scene = makeScene();
  const st = sceneState(scene, 1);
  renderScene(ctx, scene, st, { x: 100, y: 200, w: 40, h: 40 });

  const names = calls.map((c) => c[0]);
  assert.ok(names.includes("translate"));
  assert.ok(names.includes("scale"));
  assert.ok(names.includes("fillRect"));
  assert.ok(names.includes("beginPath"));
  assert.ok(names.includes("stroke"));
  assert.ok(names.includes("arc"));
  assert.ok(names.includes("fillText"));
  assert.equal(names.filter((n) => n === "save").length, names.filter((n) => n === "restore").length);
});

test("easeOutCubic 与 smoothstep 边界", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(smoothstep(0.5, 0, 1), 0.5);
  assert.equal(smoothstep(-1, 0, 1), 0);
  assert.equal(smoothstep(2, 0, 1), 1);
});
