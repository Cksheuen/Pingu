import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getPlanetSurface,
  planetSurfaceCacheKey,
  planetSurfaceType,
} from "../src/lib/planetTexture";

describe("planetTexture", () => {
  test("returns null in Node / headless environments without WebGL", () => {
    // Node 下无 document/WebGL，静默降级
    assert.equal(getPlanetSurface(7, 0, "#4338ca"), null);
    assert.equal(getPlanetSurface(7, 1, "#1f3a5f"), null);
  });

  test("cache key is stable per seed/surfaceType/baseHex and distinguishes inputs", () => {
    assert.equal(planetSurfaceCacheKey(7, 0, "#4338ca"), "7-0-#4338ca");
    assert.equal(
      planetSurfaceCacheKey(7, 0, "#4338ca"),
      planetSurfaceCacheKey(7, 0, "#4338ca")
    );
    assert.notEqual(
      planetSurfaceCacheKey(7, 0, "#4338ca"),
      planetSurfaceCacheKey(8, 0, "#4338ca")
    );
    assert.notEqual(
      planetSurfaceCacheKey(7, 0, "#4338ca"),
      planetSurfaceCacheKey(7, 1, "#4338ca")
    );
    assert.notEqual(
      planetSurfaceCacheKey(7, 0, "#4338ca"),
      planetSurfaceCacheKey(7, 0, "#1f3a5f")
    );
  });

  test("rejects invalid parameters", () => {
    assert.equal(getPlanetSurface(NaN, 0, "#4338ca"), null);
    assert.equal(getPlanetSurface(Infinity, 0, "#4338ca"), null);
    assert.equal(getPlanetSurface(7, 2, "#4338ca"), null);
    assert.equal(getPlanetSurface(7, -1, "#4338ca"), null);
    assert.equal(getPlanetSurface(7, 0, "not-a-color"), null);
    assert.equal(getPlanetSurface(7, 0, "#gggggg"), null);
    assert.equal(getPlanetSurface(7, 0, ""), null);
  });

  test("planetSurfaceType maps bands to rocky/banded", () => {
    assert.equal(planetSurfaceType(0), 0);
    assert.equal(planetSurfaceType(3), 1);
    assert.equal(planetSurfaceType(-1), 0);
  });
});
