import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARTWORK_BY_ROUTE,
  ARTWORK_OPERATOR_ID,
  TAB_ROUTES,
  getArtworkBrandSrc,
  getArtworkConfig,
  getArtworkDensity,
  resolveArtworkHeroFrame,
  type ArtworkConfig,
  type TabRoute,
} from "../src/lib/artworkConfig";
import {
  DESKTOP_DENSITY,
  MOBILE_DENSITY,
  plumeTopologyCompatible,
  prepareOrbitalPlume,
  type OrbitalPlumeParams,
  type PlumeDensity,
  type PreparedPlume,
} from "../src/lib/orbitalPlume";

function proceduralParams(config: ArtworkConfig): OrbitalPlumeParams {
  if (config.source.kind !== "procedural") assert.fail("expected procedural artwork source");
  return config.source.params;
}

function prepareRoute(route: TabRoute, density: PlumeDensity): PreparedPlume {
  const config = ARTWORK_BY_ROUTE[route];
  return prepareOrbitalPlume(
    proceduralParams(config),
    config.composition.width,
    config.composition.height,
    density,
    config.motion.channels,
    config.composition.safeZones
  );
}

function assertFiniteGeometry(plume: PreparedPlume): void {
  for (const values of [
    plume.spine,
    plume.spineN,
    plume.featherDrift,
    plume.barbs,
    plume.stars,
    plume.craters,
    plume.orbit,
  ]) {
    for (const value of values) assert.ok(Number.isFinite(value));
  }
  for (const value of [plume.core.x, plume.core.y, plume.core.r]) {
    assert.ok(Number.isFinite(value));
  }
}

describe("artwork config", () => {
  it("registers four unique procedural tab routes with shared composition", () => {
    assert.equal(TAB_ROUTES.length, 4);

    const configs = TAB_ROUTES.map((route) => ARTWORK_BY_ROUTE[route]);
    assert.equal(new Set(configs.map((config) => config.id)).size, 4);
    assert.equal(
      new Set(configs.map(proceduralParams).map((params) => params.seed)).size,
      4
    );

    for (const config of configs) {
      assert.equal(config.source.kind, "procedural");
      if (config.source.kind !== "procedural") assert.fail("expected procedural source");
      assert.equal(config.source.operator, ARTWORK_OPERATOR_ID);
      assert.deepEqual(config.composition, {
        width: 900,
        height: 640,
        safeZones: [{ x: 32, y: 64, w: 500, h: 512 }],
        mobileFrame: {
          widthRatio: 0.9,
          alignX: 1,
          centerY: 0.53,
        },
      });
      assert.equal(config.motion.routeMorphDurationMs, 700);
      assert.equal(config.quality.dprCap, 2);
      assert.equal(config.quality.mobileBreakpoint, 720);
      assert.equal(config.fallback.poster, config.fallback.coreIcon);
    }
  });

  it("exposes feathers and planet params on every procedural route", () => {
    for (const route of TAB_ROUTES) {
      const params = proceduralParams(ARTWORK_BY_ROUTE[route]);

      assert.equal("spine" in params, false, `${route} no longer carries the legacy spine block`);
      assert.deepEqual(Object.keys(params.feathers).sort(), [
        "curl",
        "distribution",
        "drift",
        "jitter",
        "length",
        "taper",
        "width",
      ]);
      assert.deepEqual(Object.keys(params.planet).sort(), [
        "atmosphere",
        "bandTilt",
        "bands",
        "lightAngle",
      ]);
      const featherScalars = [
        params.feathers.length,
        params.feathers.width,
        params.feathers.taper,
        params.feathers.curl,
        params.feathers.jitter,
        params.feathers.distribution.spread,
        params.feathers.distribution.jitter,
        params.feathers.drift.amplitude,
        params.feathers.drift.frequency,
      ];
      for (const value of featherScalars) {
        assert.ok(Number.isFinite(value), `${route} feathers values must be finite`);
      }
      for (const value of Object.values(params.planet)) {
        assert.ok(Number.isFinite(value), `${route} planet values must be finite`);
      }
    }
  });

  it("resolves fallback config, density, and brand source", () => {
    const home = ARTWORK_BY_ROUTE.home;

    assert.equal(getArtworkConfig("article"), home);
    assert.equal(getArtworkDensity(home, 720), MOBILE_DENSITY);
    assert.equal(getArtworkDensity(home, 721), DESKTOP_DENSITY);
    assert.equal(getArtworkBrandSrc(home), home.fallback.coreIcon);
  });

  it("keeps the full hero rect on desktop and without a mobile frame", () => {
    const home = ARTWORK_BY_ROUTE.home;
    const hero = { x: 12, y: 34, w: 390, h: 844 };

    assert.equal(resolveArtworkHeroFrame(home, hero, 721), hero);
    assert.equal(resolveArtworkHeroFrame(home, hero, 1200), hero);

    const noMobileFrame: ArtworkConfig = {
      ...home,
      composition: { ...home.composition, mobileFrame: undefined },
    };
    assert.equal(resolveArtworkHeroFrame(noMobileFrame, hero, 390), hero);
  });

  it("resolves the shared mobile frame for a 390x844 hero", () => {
    const frame = resolveArtworkHeroFrame(
      ARTWORK_BY_ROUTE.home,
      { x: 0, y: 0, w: 390, h: 844 },
      390
    );

    assert.ok(Math.abs(frame.x - 39) < 1e-9);
    assert.ok(Math.abs(frame.y - 322.52) < 1e-9);
    assert.ok(Math.abs(frame.w - 351) < 1e-9);
    assert.ok(Math.abs(frame.h - 249.6) < 1e-9);
    assert.ok(Math.abs(frame.y + frame.h / 2 - 447.32) < 1e-9);
  });

  it("sanitizes malformed mobile frames to finite bounded geometry", () => {
    const home = ARTWORK_BY_ROUTE.home;
    const hero = { x: 0, y: 0, w: 390, h: 120 };
    const malformed: ArtworkConfig = {
      ...home,
      composition: {
        ...home.composition,
        mobileFrame: {
          widthRatio: Number.NaN,
          alignX: Number.POSITIVE_INFINITY,
          centerY: Number.NEGATIVE_INFINITY,
        },
      },
    };
    const frame = resolveArtworkHeroFrame(malformed, hero, 390);

    for (const value of [frame.x, frame.y, frame.w, frame.h]) {
      assert.ok(Number.isFinite(value));
      assert.ok(value >= 0);
    }
    assert.ok(frame.x + frame.w <= hero.x + hero.w + 1e-9);
    assert.ok(frame.y + frame.h <= hero.y + hero.h + 1e-9);
  });

  it("prepares finite desktop and mobile plumes with fixed geometry budgets", () => {
    const desktopPlumes = TAB_ROUTES.map((route) => {
      const plume = prepareRoute(route, DESKTOP_DENSITY);
      assert.equal(plume.starCount, 48);
      // featherCount 5: 5*64 + 24*4 + 48*8 + 96 + 40 + 8*8 = 1000
      assert.equal(plume.vertexCount, 1000);
      assertFiniteGeometry(plume);
      return plume;
    });

    const mobilePlumes = TAB_ROUTES.map((route) => {
      const plume = prepareRoute(route, MOBILE_DENSITY);
      assert.equal(plume.starCount, 24);
      // featherCount 3: 3*48 + 12*4 + 24*8 + 64 + 40 + 5*8 = 528
      assert.equal(plume.vertexCount, 528);
      assertFiniteGeometry(plume);
      return plume;
    });

    assert.equal(mobilePlumes.length, TAB_ROUTES.length);

    for (let i = 0; i < desktopPlumes.length; i++) {
      for (let j = i + 1; j < desktopPlumes.length; j++) {
        assert.ok(
          plumeTopologyCompatible(desktopPlumes[i], desktopPlumes[j]),
          `desktop plumes ${TAB_ROUTES[i]} and ${TAB_ROUTES[j]} must be morph-compatible`
        );
      }
    }

    for (let i = 0; i < mobilePlumes.length; i++) {
      for (let j = i + 1; j < mobilePlumes.length; j++) {
        assert.ok(
          plumeTopologyCompatible(mobilePlumes[i], mobilePlumes[j]),
          `mobile plumes ${TAB_ROUTES[i]} and ${TAB_ROUTES[j]} must be morph-compatible`
        );
      }
    }
  });

  it("allows type-safe vector/raster source substitution while retaining fallback branding", () => {
    const home = ARTWORK_BY_ROUTE.home;

    const vectorFixture: ArtworkConfig = {
      ...home,
      id: "vector-fixture",
      source: {
        kind: "vector",
        src: "/assets/vector-fixture.svg",
        topologyId: "fixture-topology",
      },
    };

    const rasterFixture: ArtworkConfig = {
      ...home,
      id: "raster-fixture",
      source: {
        kind: "raster",
        src: "/assets/raster-fixture.png",
      },
    };

    if (vectorFixture.source.kind !== "vector") assert.fail("expected vector source");
    assert.equal(vectorFixture.source.src, "/assets/vector-fixture.svg");
    assert.equal(vectorFixture.source.topologyId, "fixture-topology");

    if (rasterFixture.source.kind !== "raster") assert.fail("expected raster source");
    assert.equal(rasterFixture.source.src, "/assets/raster-fixture.png");

    assert.equal(getArtworkBrandSrc(vectorFixture), home.fallback.coreIcon);
    assert.equal(getArtworkBrandSrc(rasterFixture), home.fallback.coreIcon);
  });
});
