import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHANNELS,
  DESKTOP_DENSITY,
  MOBILE_DENSITY,
  SURFACE_TEXTURE_ALPHA,
  drawOrbitalPlume,
  drawPlanetSurfaceOverlay,
  plumeTopologyCompatible,
  prepareOrbitalPlume,
  resolvePlumeMorph,
  type OrbitalPlumeParams,
  type PlumeDensity,
  type PlumeDrawContext,
  type PlumeGradient,
  type PreparedPlume,
  type SafeZone,
} from "../src/lib/orbitalPlume";

const SCENE_W = 900;
const SCENE_H = 640;
const TAU = Math.PI * 2;

const BASE_PARAMS: OrbitalPlumeParams = {
  seed: 7,
  feathers: {
    length: 0.32,
    width: 0.05,
    taper: 1.1,
    curl: 0.35,
    jitter: 0.12,
    distribution: { spread: 0.38, jitter: 0.05 },
    drift: { amplitude: 0.005, frequency: 3 },
  },
  core: { x: 0.02, y: -0.01, r: 0.08 },
  planet: { lightAngle: -0.9, atmosphere: 0.7, bands: 0, bandTilt: 0 },
  orbit: { rx: 0.16, ry: 0.1, rotation: 0.35 },
  barbs: { length: 0.12, sweep: 0.06, curl: 1, taper: 1.2 },
  stars: { spread: 0.26, jitter: 0.15 },
  curl: { amplitude: 0.03, frequency: 3 },
  colors: {
    core: "#0b1020",
    ring: "#7dd3fc",
    spine: "#a5b4fc",
    barb: "#38bdf8",
    star: "#e0f2fe",
    dust: "#94a3b8",
  },
};

const FULL_SCENE: SafeZone = { x: 0, y: 0, w: SCENE_W, h: SCENE_H };

type Recorder = PlumeDrawContext & {
  calls: string[];
  arcs: number[][];
  points: number[][];
  drawImages: { args: unknown[]; alpha: number; composite: string }[];
};

function makeRecorder(): Recorder {
  const target = {
    calls: [] as string[],
    arcs: [] as number[][],
    points: [] as number[][],
    drawImages: [] as { args: unknown[]; alpha: number; composite: string }[],
  };
  const gradientStub: PlumeGradient = { addColorStop: () => {} };

  return new Proxy(target, {
    get(t, property) {
      if (property in t) {
        return t[property as keyof typeof t];
      }

      if (property === "createRadialGradient" || property === "createLinearGradient") {
        return (..._args: number[]): PlumeGradient => {
          t.calls.push(String(property));
          return gradientStub;
        };
      }

      if (property === "drawImage") {
        return (...args: unknown[]): void => {
          t.calls.push("drawImage");
          t.drawImages.push({
            args,
            alpha: (t as Record<string, unknown>).globalAlpha as number,
            composite: (t as Record<string, unknown>).globalCompositeOperation as string,
          });
        };
      }

      return (...args: number[]) => {
        t.calls.push(String(property));
        if (property === "arc") t.arcs.push(args);
        if (property === "moveTo" || property === "lineTo") t.points.push(args);
      };
    },
    set(t, property, value) {
      (t as Record<PropertyKey, unknown>)[property] = value;
      return true;
    },
  }) as Recorder;
}

function countCalls(ctx: Recorder, name: string): number {
  return ctx.calls.filter((call) => call === name).length;
}

const ZERO_DENSITY: PlumeDensity = {
  spineSamples: 4,
  barbsPerSide: 0,
  starCount: 0,
  orbitSamples: 0,
  featherCount: 0,
  craterCount: 0,
};

/** 手工构造最小 PreparedPlume，用于渲染器分层断言（不经过 prepare） */
function makePlume(init: {
  density?: PlumeDensity;
  stars?: number[];
  starKinds?: number[];
  craters?: number[];
  spine?: number[];
  spineN?: number[];
  barbs?: number[];
  orbit?: number[];
  core?: { x: number; y: number; r: number };
  planet?: OrbitalPlumeParams["planet"];
  feathers?: OrbitalPlumeParams["feathers"];
}): PreparedPlume {
  return {
    params: {
      ...BASE_PARAMS,
      planet: init.planet ?? BASE_PARAMS.planet,
      feathers: init.feathers ?? BASE_PARAMS.feathers,
    },
    channels: DEFAULT_CHANNELS,
    density: init.density ?? ZERO_DENSITY,
    sceneW: SCENE_W,
    sceneH: SCENE_H,
    spine: new Float32Array(init.spine ?? []),
    spineN: new Float32Array(init.spineN ?? []),
    featherDrift: new Float32Array((init.density ?? ZERO_DENSITY).featherCount * 2),
    barbs: new Float32Array(init.barbs ?? []),
    stars: new Float32Array(init.stars ?? []),
    starKinds: new Uint8Array(init.starKinds ?? []),
    craters: new Float32Array(init.craters ?? []),
    starCount: init.stars ? init.stars.length / 7 : 0,
    orbit: new Float32Array(init.orbit ?? []),
    core: init.core ?? { x: 450, y: 320, r: 50 },
    vertexCount: 0,
  };
}

function assertGeometryEqual(actual: PreparedPlume, expected: PreparedPlume): void {
  assert.deepEqual(actual.spine, expected.spine);
  assert.deepEqual(actual.spineN, expected.spineN);
  assert.deepEqual(actual.featherDrift, expected.featherDrift);
  assert.deepEqual(actual.barbs, expected.barbs);
  assert.deepEqual(actual.stars, expected.stars);
  assert.deepEqual(actual.starKinds, expected.starKinds);
  assert.deepEqual(actual.craters, expected.craters);
  assert.deepEqual(actual.orbit, expected.orbit);
  assert.deepEqual(actual.core, expected.core);
  assert.equal(actual.starCount, expected.starCount);
  assert.equal(actual.vertexCount, expected.vertexCount);
}

describe("orbitalPlume", () => {
  test("identical inputs produce identical prepared geometry", () => {
    const a = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);
    const b = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);

    assertGeometryEqual(a, b);
  });

  test("density constants control array lengths and vertex budget", () => {
    const desktop = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);

    assert.equal(desktop.spine.length, DESKTOP_DENSITY.featherCount * DESKTOP_DENSITY.spineSamples * 2);
    assert.equal(desktop.spineN.length, DESKTOP_DENSITY.featherCount * DESKTOP_DENSITY.spineSamples * 2);
    assert.equal(desktop.barbs.length, DESKTOP_DENSITY.barbsPerSide * 2 * 4);
    assert.equal(desktop.stars.length, DESKTOP_DENSITY.starCount * 7);
    assert.equal(desktop.starKinds.length, DESKTOP_DENSITY.starCount);
    assert.equal(desktop.craters.length, DESKTOP_DENSITY.craterCount * 4);
    assert.equal(desktop.orbit.length, DESKTOP_DENSITY.orbitSamples * 2);
    assert.equal(desktop.starCount, DESKTOP_DENSITY.starCount);
    // vertexCount = featherCount*spineSamples + barbsPerSide*2*2 + starCount*8 + orbitSamples + 40 + craterCount*8
    // = 5*64 + 24*4 + 48*8 + 96 + 40 + 8*8 = 320 + 96 + 384 + 96 + 40 + 64 = 1000
    assert.equal(desktop.vertexCount, 1000);

    const mobile = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, MOBILE_DENSITY);

    assert.equal(mobile.spine.length, MOBILE_DENSITY.featherCount * MOBILE_DENSITY.spineSamples * 2);
    assert.equal(mobile.spineN.length, MOBILE_DENSITY.featherCount * MOBILE_DENSITY.spineSamples * 2);
    assert.equal(mobile.barbs.length, MOBILE_DENSITY.barbsPerSide * 2 * 4);
    assert.equal(mobile.stars.length, MOBILE_DENSITY.starCount * 7);
    assert.equal(mobile.starKinds.length, MOBILE_DENSITY.starCount);
    assert.equal(mobile.craters.length, MOBILE_DENSITY.craterCount * 4);
    assert.equal(mobile.orbit.length, MOBILE_DENSITY.orbitSamples * 2);
    assert.equal(mobile.starCount, MOBILE_DENSITY.starCount);
    // = 3*48 + 12*4 + 24*8 + 64 + 40 + 5*8 = 144 + 48 + 192 + 64 + 40 + 40 = 528
    assert.equal(mobile.vertexCount, 528);
  });

  test("feathers distribute on a golden-angle spiral instead of the planet rim", () => {
    const plume = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);
    const K = DESKTOP_DENSITY.featherCount;
    const H = SCENE_H;
    const cx = SCENE_W / 2 + BASE_PARAMS.core.x * H;
    const cy = SCENE_H / 2 + BASE_PARAMS.core.y * H;
    const spread = BASE_PARAMS.feathers.distribution.spread;
    const posJitter = BASE_PARAMS.feathers.distribution.jitter;
    const rimR = BASE_PARAMS.core.r * H * 0.85;
    // 位置 jitter 每轴 ±jitter/2，距离误差上界 = jitter/√2
    const tol = (posJitter * H) / Math.SQRT2 + 1e-3;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let k = 0; k < K; k++) {
      const rootIdx = k * DESKTOP_DENSITY.spineSamples * 2;
      const rx = plume.spine[rootIdx];
      const ry = plume.spine[rootIdx + 1];
      const dist = Math.hypot(rx - cx, ry - cy);

      // 无 safeZone 时第 k 根羽毛对应 n=k：radius = spread·√(k/K)
      const expected = spread * Math.sqrt(k / K) * H;
      assert.ok(Math.abs(dist - expected) < tol, `feather ${k} sits on the golden-angle spiral`);

      // 不再锚定星球 rim
      assert.ok(Math.abs(dist - rimR) > 1, `feather ${k} is not anchored on the planet rim`);

      // 方向沿切线：root→tip 弦向与螺旋切线（angle + π/2）近似一致，偏差只剩方向 jitter
      const tipIdx = (k * DESKTOP_DENSITY.spineSamples + DESKTOP_DENSITY.spineSamples - 1) * 2;
      const chordX = plume.spine[tipIdx] - rx;
      const chordY = plume.spine[tipIdx + 1] - ry;
      const chordLen = Math.hypot(chordX, chordY);
      const tangentAngle = k * goldenAngle + Math.PI / 2;
      const dot = (chordX * Math.cos(tangentAngle) + chordY * Math.sin(tangentAngle)) / chordLen;
      assert.ok(dot > 0.9, `feather ${k} chord follows the spiral tangent`);
    }
  });

  test("feather drift is baked per feather and offsets positions (constant, not scroll-driven)", () => {
    // 去掉星点与轨道，让羽毛调用成为第一批 moveTo/lineTo，便于坐标断言
    const density: PlumeDensity = { ...DESKTOP_DENSITY, starCount: 0, orbitSamples: 0 };
    const plume = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, density);
    const K = density.featherCount;

    assert.equal(plume.featherDrift.length, K * 2);
    // curl noise 空间变化：不同羽毛的漂移向量不同
    const unique = new Set<string>();
    for (let k = 0; k < K; k++) {
      unique.add(`${plume.featherDrift[k * 2]},${plume.featherDrift[k * 2 + 1]}`);
    }
    assert.ok(unique.size > 1, "drift varies across feathers");

    const ctx0 = makeRecorder();
    drawOrbitalPlume(ctx0, plume, 0);
    const ctxHalf = makeRecorder();
    drawOrbitalPlume(ctxHalf, plume, 0.5);

    // 漂移为恒定偏移（不随 scroll s 变化）：s=0 与 s=0.5 的羽毛位置相同
    const p0 = ctx0.points[0];
    const pHalf = ctxHalf.points[0];
    assert.ok(
      Math.abs(pHalf[0] - p0[0]) < 1e-4,
      "root x does not change with scroll s (constant drift)"
    );
    assert.ok(
      Math.abs(pHalf[1] - p0[1]) < 1e-4,
      "root y does not change with scroll s (constant drift)"
    );
    // 漂移确实被应用：root 位置 = spine root + featherDrift
    const spineRootX = plume.spine[0];
    const spineRootY = plume.spine[1];
    assert.ok(
      Math.abs(p0[0] - (spineRootX + plume.featherDrift[0])) < 1e-4,
      "root x = spine root x + featherDrift x"
    );
    assert.ok(
      Math.abs(p0[1] - (spineRootY + plume.featherDrift[1])) < 1e-4,
      "root y = spine root y + featherDrift y"
    );
  });

  test("stars bake rotation, halo, aspect and kind attributes", () => {
    const plume = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);

    for (let i = 0; i < plume.starCount; i++) {
      const rotation = plume.stars[i * 7 + 4];
      const halo = plume.stars[i * 7 + 5];
      const aspect = plume.stars[i * 7 + 6];
      assert.ok(rotation >= 0 && rotation <= TAU, "rotation in [0, 2π)");
      assert.ok(halo === 0 || halo >= 2, "halo is either absent or a ≥2× multiplier");
      assert.ok(aspect >= 0.6 && aspect <= 1.4, "aspect bounded");
      assert.ok(
        plume.starKinds[i] === 0 || plume.starKinds[i] === 1 || plume.starKinds[i] === 2,
        "kind in {dot, sparkle4, star5}"
      );
    }
  });

  test("craters bake inside the planet disk with bounded radius and depth", () => {
    const plume = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);

    for (let c = 0; c < DESKTOP_DENSITY.craterCount; c++) {
      const nx = plume.craters[c * 4];
      const ny = plume.craters[c * 4 + 1];
      const r = plume.craters[c * 4 + 2];
      const depth = plume.craters[c * 4 + 3];
      assert.ok(nx * nx + ny * ny <= 1, `crater ${c} sits inside the unit disk`);
      assert.ok(r >= 0.05 && r <= 0.25, `crater ${c} radius bounded`);
      assert.ok(depth >= 0.2 && depth <= 0.9, `crater ${c} depth bounded`);
    }
  });

  test("full-scene safe zone removes stars; s=0 draws planet, orbit and feathers", () => {
    const plume = prepareOrbitalPlume(
      BASE_PARAMS,
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY,
      undefined,
      [FULL_SCENE]
    );
    const ctx = makeRecorder();

    assert.equal(plume.starCount, 0);

    drawOrbitalPlume(ctx, plume, 0);

    // 星球本体：clip 圆 + 8 个陨石坑 arc（无星星 arc）
    assert.equal(countCalls(ctx, "clip"), 1);
    assert.deepEqual(ctx.arcs[0], [plume.core.x, plume.core.y, plume.core.r, 0, TAU]);
    assert.equal(ctx.arcs.length, 1 + DESKTOP_DENSITY.craterCount);
    // 径向渐变：大气 + 8 陨石坑 + 光照 + 高光
    assert.equal(
      countCalls(ctx, "createRadialGradient"),
      1 + DESKTOP_DENSITY.craterCount + 2
    );
    // 轨道前后半弧 + 羽毛（羽片/羽轴/羽枝）都有路径
    assert.ok(countCalls(ctx, "moveTo") > 0);
    assert.ok(countCalls(ctx, "lineTo") > 0);
    assert.equal(countCalls(ctx, "translate"), 0);
  });

  test("s=1 keeps all layers visible (no scroll-driven subtraction)", () => {
    const plume = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);
    const ctx = makeRecorder();

    drawOrbitalPlume(ctx, plume, 1);

    // 星球：clip 圆 + 陨石坑（星星 dot 也会用 arc，所以 arcs 总数 > 1 + craterCount）
    assert.equal(countCalls(ctx, "clip"), 1);
    assert.ok(ctx.arcs.length >= 1 + DESKTOP_DENSITY.craterCount, "planet clip + craters arcs present");
    // 径向渐变：大气 + 陨石坑 + 光照 + 高光（星星 halo 也会增加，所以 >=）
    assert.ok(
      countCalls(ctx, "createRadialGradient") >= 1 + DESKTOP_DENSITY.craterCount + 2,
      "atmosphere + craters + lighting + highlight gradients present"
    );
    // 星星、轨道、羽毛在 s=1 时仍然绘制（不下滑淡出）
    assert.ok(countCalls(ctx, "moveTo") > 0, "stars/orbit/feathers still draw at s=1");
    assert.ok(countCalls(ctx, "lineTo") > 0, "feather vanes/barbs still draw at s=1");
    assert.ok(countCalls(ctx, "stroke") > 0, "orbit/spine/barbs still stroke at s=1");
  });

  test("stars render dot / sparkle4 / star5 shapes with halo gradients", () => {
    // 3 颗星：dot（无 halo）、sparkle4（halo=3）、star5（无 halo）
    const plume = makePlume({
      stars: [
        10, 10, 2, 0.5, 0, 0, 1,
        20, 20, 2, 0.5, 0.4, 3, 0.8,
        30, 30, 2, 0.5, 0.8, 0, 1.2,
      ],
      starKinds: [0, 1, 2],
    });
    const ctx = makeRecorder();

    drawOrbitalPlume(ctx, plume, 0);

    // 每颗星一次 translate/rotate/scale 变换
    assert.equal(countCalls(ctx, "translate"), 3);
    assert.equal(countCalls(ctx, "rotate"), 3);
    assert.equal(countCalls(ctx, "scale"), 3);
    // sparkle4（8 顶点）+ star5（10 顶点）各一次 moveTo 起手 + closePath
    assert.equal(countCalls(ctx, "moveTo"), 2);
    assert.equal(countCalls(ctx, "lineTo"), 7 + 9);
    assert.equal(countCalls(ctx, "closePath"), 2);
    assert.equal(countCalls(ctx, "fill"), 3);
    // 径向渐变：1 个 halo + 大气 + 光照 + 高光
    assert.equal(countCalls(ctx, "createRadialGradient"), 4);
    // arc 只出现在 dot 星与星球 clip 圆
    assert.equal(ctx.arcs.length, 2);
  });

  test("planet body clips a circle and layers craters, lighting and highlight", () => {
    const plume = makePlume({
      density: { ...ZERO_DENSITY, craterCount: 1 },
      craters: [0.2, 0.2, 0.1, 0.6],
    });
    const ctx = makeRecorder();

    drawOrbitalPlume(ctx, plume, 0);

    assert.equal(countCalls(ctx, "clip"), 1);
    assert.deepEqual(ctx.arcs[0], [450, 320, 50, 0, TAU]);
    assert.equal(ctx.arcs.length, 2); // clip 圆 + 1 陨石坑
    // 径向渐变：大气 + 1 陨石坑 + 光照 + 高光
    assert.equal(countCalls(ctx, "createRadialGradient"), 4);
    assert.equal(countCalls(ctx, "fillRect"), 4); // 大气 + 底色 + 光照 + 高光
    assert.equal(countCalls(ctx, "fill"), 1); // 仅陨石坑用 fill
    assert.equal(countCalls(ctx, "createLinearGradient"), 0); // 无羽毛
    assert.equal(countCalls(ctx, "moveTo"), 0);
    assert.equal(countCalls(ctx, "lineTo"), 0);
  });

  test("assets surface overlays the texture inside the planet clip", () => {
    const plume = makePlume({ density: ZERO_DENSITY });
    const surface = {} as HTMLCanvasElement;
    const ctx = makeRecorder();

    drawOrbitalPlume(ctx, plume, 0, undefined, { surface });

    assert.equal(countCalls(ctx, "drawImage"), 1);
    const rec = ctx.drawImages[0];
    assert.equal(rec.args[0], surface);
    // 目标矩形 = 星球包围盒：cx-r, cy-r, 2r, 2r（core 默认 {450,320,50}）
    assert.deepEqual(rec.args.slice(1), [400, 270, 100, 100]);
    assert.equal(rec.alpha, SURFACE_TEXTURE_ALPHA);
    assert.equal(rec.composite, "soft-light");
    // 叠加后恢复状态
    assert.equal(ctx.globalAlpha, 1);
    assert.equal(ctx.globalCompositeOperation, "source-over");
  });

  test("no assets or null surface skips the texture overlay", () => {
    const plume = makePlume({ density: ZERO_DENSITY });

    const ctxWithout = makeRecorder();
    drawOrbitalPlume(ctxWithout, plume, 0);
    assert.equal(countCalls(ctxWithout, "drawImage"), 0);

    const ctxNull = makeRecorder();
    drawOrbitalPlume(ctxNull, plume, 0, undefined, { surface: null });
    assert.equal(countCalls(ctxNull, "drawImage"), 0);
  });

  test("drawPlanetSurfaceOverlay skips null surface and zero weight", () => {
    const core = { x: 10, y: 20, r: 5 };
    const surface = {} as HTMLCanvasElement;
    const ctx = makeRecorder();

    drawPlanetSurfaceOverlay(ctx, core, null);
    assert.equal(countCalls(ctx, "drawImage"), 0);

    drawPlanetSurfaceOverlay(ctx, core, surface, 0);
    assert.equal(countCalls(ctx, "drawImage"), 0);

    drawPlanetSurfaceOverlay(ctx, core, surface, 0.5);
    assert.equal(countCalls(ctx, "drawImage"), 1);
    const rec = ctx.drawImages[0];
    assert.equal(rec.args[0], surface);
    assert.deepEqual(rec.args.slice(1), [5, 15, 10, 10]);
    assert.equal(rec.alpha, SURFACE_TEXTURE_ALPHA * 0.5);
    assert.equal(rec.composite, "soft-light");
  });

  test("feathers render vane silhouette, rachis and barb lines", () => {
    const spine: number[] = [];
    const spineN: number[] = [];
    for (let i = 0; i < 4; i++) {
      spine.push(100 + i * 10, 100);
      spineN.push(0, 1);
    }
    const plume = makePlume({
      spine,
      spineN,
      barbs: [105, 100, 105, 120, 115, 100, 115, 120],
      density: { ...ZERO_DENSITY, featherCount: 1, barbsPerSide: 1 },
    });
    const ctx = makeRecorder();

    drawOrbitalPlume(ctx, plume, 0);

    // 羽片：root→tip 线性渐变 + 闭合填充
    assert.equal(countCalls(ctx, "createLinearGradient"), 1);
    assert.equal(countCalls(ctx, "closePath"), 1);
    assert.equal(countCalls(ctx, "fill"), 1);
    // 羽片：1 moveTo + 7 lineTo（左缘 3 + 右缘 4）；羽轴：1 moveTo + 3 lineTo；羽枝每侧 1 根：2 moveTo + 2 lineTo
    assert.equal(countCalls(ctx, "moveTo"), 4);
    assert.equal(countCalls(ctx, "lineTo"), 7 + 3 + 2);
    assert.equal(countCalls(ctx, "stroke"), 2); // 羽轴 + 羽枝（一批）
  });

  test("same-density seed variants morph with reused scratch and clamped t", () => {
    const from = prepareOrbitalPlume(
      { ...BASE_PARAMS, seed: 11 },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );
    const to = prepareOrbitalPlume(
      { ...BASE_PARAMS, seed: 29 },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );

    assert.ok(plumeTopologyCompatible(from, to));

    const atStart = resolvePlumeMorph(to, { from, t: 0 });
    assertGeometryEqual(atStart, from);

    const atEnd = resolvePlumeMorph(to, { from, t: 1 });
    assertGeometryEqual(atEnd, to);
    assert.strictEqual(atStart, atEnd);

    const clampedLow = resolvePlumeMorph(to, { from, t: -2 });
    assert.strictEqual(clampedLow, atStart);
    assertGeometryEqual(clampedLow, from);

    const clampedHigh = resolvePlumeMorph(to, { from, t: 2 });
    assert.strictEqual(clampedHigh, atStart);
    assertGeometryEqual(clampedHigh, to);
  });

  test("starKinds switch as a discrete threshold at t = 0.5", () => {
    const from = prepareOrbitalPlume(
      { ...BASE_PARAMS, seed: 101 },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );
    const to = prepareOrbitalPlume(
      { ...BASE_PARAMS, seed: 202 },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );
    assert.ok(
      !from.starKinds.every((kind, i) => kind === to.starKinds[i]),
      "seed variants must bake different star kinds"
    );

    const before = resolvePlumeMorph(to, { from, t: 0.49 });
    assert.deepEqual(Array.from(before.starKinds), Array.from(from.starKinds));

    const after = resolvePlumeMorph(to, { from, t: 0.51 });
    assert.deepEqual(Array.from(after.starKinds), Array.from(to.starKinds));
  });

  test("craters lerp continuously between seed variants", () => {
    const from = prepareOrbitalPlume(
      { ...BASE_PARAMS, seed: 101 },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );
    const to = prepareOrbitalPlume(
      { ...BASE_PARAMS, seed: 202 },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );

    const mid = resolvePlumeMorph(to, { from, t: 0.5 });

    assert.equal(mid.craters.length, from.craters.length);
    for (let i = 0; i < from.craters.length; i++) {
      assert.ok(Math.abs(mid.craters[i] - (from.craters[i] + to.craters[i]) / 2) < 1e-5);
    }
  });

  test("morph rejects incompatible density and safe-zone topologies", () => {
    const desktop = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, DESKTOP_DENSITY);
    const mobile = prepareOrbitalPlume(BASE_PARAMS, SCENE_W, SCENE_H, MOBILE_DENSITY);

    assert.equal(plumeTopologyCompatible(desktop, mobile), false);
    assert.throws(
      () => resolvePlumeMorph(desktop, { from: mobile, t: 0 }),
      RangeError
    );

    const hidden = prepareOrbitalPlume(
      BASE_PARAMS,
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY,
      undefined,
      [FULL_SCENE]
    );

    assert.equal(plumeTopologyCompatible(desktop, hidden), false);
    assert.throws(
      () => resolvePlumeMorph(desktop, { from: hidden, t: 0 }),
      RangeError
    );
  });

  test("barb curl changes tips without changing roots", () => {
    const flat = prepareOrbitalPlume(
      { ...BASE_PARAMS, barbs: { ...BASE_PARAMS.barbs, curl: 0 } },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );
    const curled = prepareOrbitalPlume(
      { ...BASE_PARAMS, barbs: { ...BASE_PARAMS.barbs, curl: 2 } },
      SCENE_W,
      SCENE_H,
      DESKTOP_DENSITY
    );

    let tipChanged = false;

    for (let i = 0; i < flat.barbs.length; i += 4) {
      assert.equal(flat.barbs[i], curled.barbs[i]);
      assert.equal(flat.barbs[i + 1], curled.barbs[i + 1]);

      if (
        flat.barbs[i + 2] !== curled.barbs[i + 2] ||
        flat.barbs[i + 3] !== curled.barbs[i + 3]
      ) {
        tipChanged = true;
      }
    }

    assert.ok(tipChanged);
  });
});
