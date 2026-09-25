import test from "node:test";
import assert from "node:assert/strict";
import { lerpColor, tokenizePath, pathTopologyCompatible, lerpPathD } from "../src/lib/liquidMorph";

// ── 颜色插值 ─────────────────────────────────────────────

test("lerpColor t=0 返回起始色", () => {
  assert.equal(lerpColor("#ff0000", "#0000ff", 0), "rgb(255,0,0)");
});

test("lerpColor t=1 返回目标色", () => {
  assert.equal(lerpColor("#ff0000", "#0000ff", 1), "rgb(0,0,255)");
});

test("lerpColor t=0.5 返回中点", () => {
  assert.equal(lerpColor("#000000", "#ffffff", 0.5), "rgb(128,128,128)");
});

test("lerpColor 支持 3 位 hex", () => {
  assert.equal(lerpColor("#f00", "#00f", 0), "rgb(255,0,0)");
  assert.equal(lerpColor("#f00", "#00f", 1), "rgb(0,0,255)");
});

test("lerpColor 相同颜色插值不变", () => {
  assert.equal(lerpColor("#4d72cf", "#4d72cf", 0.3), "rgb(77,114,207)");
});

// ── 路径分词 ─────────────────────────────────────────────

test("tokenizePath 分解 M 和 C 命令", () => {
  const tokens = tokenizePath("M 10 20 C 30 40 50 60 70 80");
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].cmd, "M");
  assert.deepEqual(tokens[0].args, [10, 20]);
  assert.equal(tokens[1].cmd, "C");
  assert.deepEqual(tokens[1].args, [30, 40, 50, 60, 70, 80]);
});

test("tokenizePath 处理紧凑格式（无空格分隔）", () => {
  const tokens = tokenizePath("M10,20L30,40");
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].cmd, "M");
  assert.deepEqual(tokens[0].args, [10, 20]);
  assert.equal(tokens[1].cmd, "L");
  assert.deepEqual(tokens[1].args, [30, 40]);
});

test("tokenizePath 处理负数和小数", () => {
  const tokens = tokenizePath("M -5.5 10.2 L 3 -7");
  assert.equal(tokens.length, 2);
  assert.deepEqual(tokens[0].args, [-5.5, 10.2]);
  assert.deepEqual(tokens[1].args, [3, -7]);
});

test("tokenizePath 空字符串返回空数组", () => {
  assert.deepEqual(tokenizePath(""), []);
});

// ── 拓扑兼容性 ───────────────────────────────────────────

test("pathTopologyCompatible 相同路径返回 true", () => {
  const d = "M 10 20 C 30 40 50 60 70 80";
  assert.ok(pathTopologyCompatible(d, d));
});

test("pathTopologyCompatible 同构路径返回 true", () => {
  const a = "M 10 20 C 30 40 50 60 70 80";
  const b = "M 100 200 C 300 400 500 600 700 800";
  assert.ok(pathTopologyCompatible(a, b));
});

test("pathTopologyCompatible 不同命令序列返回 false", () => {
  const a = "M 10 20 C 30 40 50 60 70 80";
  const b = "M 10 20 L 30 40";
  assert.ok(!pathTopologyCompatible(a, b));
});

test("pathTopologyCompatible 不同参数数量返回 false", () => {
  const a = "M 10 20 C 30 40 50 60 70 80";
  const b = "M 10 20 C 30 40 50 60";
  assert.ok(!pathTopologyCompatible(a, b));
});

// ── 路径插值 ─────────────────────────────────────────────

test("lerpPathD t=0 返回起始路径", () => {
  const a = "M 10 20 C 30 40 50 60 70 80";
  const b = "M 100 200 C 300 400 500 600 700 800";
  const result = lerpPathD(a, b, 0);
  assert.ok(result.compatible);
  assert.equal(result.d, a);
});

test("lerpPathD t=1 返回目标路径", () => {
  const a = "M 10 20 C 30 40 50 60 70 80";
  const b = "M 100 200 C 300 400 500 600 700 800";
  const result = lerpPathD(a, b, 1);
  assert.ok(result.compatible);
  assert.equal(result.d, b);
});

test("lerpPathD t=0.5 返回中点插值", () => {
  const a = "M 0 0 L 10 10";
  const b = "M 100 100 L 200 200";
  const result = lerpPathD(a, b, 0.5);
  assert.ok(result.compatible);
  // 解析结果验证中点
  const tokens = tokenizePath(result.d);
  assert.equal(tokens[0].cmd, "M");
  assert.ok(Math.abs(tokens[0].args[0] - 50) < 0.01);
  assert.ok(Math.abs(tokens[0].args[1] - 50) < 0.01);
  assert.equal(tokens[1].cmd, "L");
  assert.ok(Math.abs(tokens[1].args[0] - 105) < 0.01);
  assert.ok(Math.abs(tokens[1].args[1] - 105) < 0.01);
});

test("lerpPathD 不兼容路径降级为离散切换", () => {
  const a = "M 10 20 C 30 40 50 60 70 80";
  const b = "M 10 20 L 30 40";
  const result0 = lerpPathD(a, b, 0.3);
  assert.ok(!result0.compatible);
  assert.equal(result0.d, a); // t < 0.5 → 起始
  const result1 = lerpPathD(a, b, 0.7);
  assert.ok(!result1.compatible);
  assert.equal(result1.d, b); // t >= 0.5 → 目标
});
