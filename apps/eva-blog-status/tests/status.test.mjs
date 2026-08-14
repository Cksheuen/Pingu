import test from "node:test";
import assert from "node:assert/strict";
import { apiUrl, normalizeAutoStatusInput, normalizeStatusInput } from "../src/statusContract.js";

test("status publisher creates a private API payload", () => {
  assert.deepEqual(normalizeStatusInput({ kind: "song", title: "  Night Drive ", details: "  side B  " }), {
    kind: "song",
    title: "Night Drive",
    details: "side B",
    source: "local-device",
    isPublic: true,
    meta: { track: "Night Drive", playing: true }
  });
  assert.equal(apiUrl("http://127.0.0.1:4174", "/api/status"), "http://127.0.0.1:4174/api/status");
});

test("status publisher preserves structured music metadata", () => {
  assert.deepEqual(normalizeStatusInput({
    kind: "song",
    track: "Night Drive",
    artist: "Eva FM",
    album: "After Hours",
    service: "Spotify",
    playing: true
  }), {
    kind: "song",
    title: "Night Drive",
    details: "",
    source: "local-device",
    isPublic: true,
    meta: {
      track: "Night Drive",
      artist: "Eva FM",
      album: "After Hours",
      service: "Spotify",
      playing: true
    }
  });
});

test("token usage is private unless explicitly made public", () => {
  assert.deepEqual(normalizeStatusInput({ kind: "token", usedTokens: "128000", limitTokens: "256000", model: "gpt-5" }), {
    kind: "token",
    title: "Token usage",
    details: "",
    source: "local-device",
    isPublic: false,
    meta: { usedTokens: 128000, limitTokens: 256000, unit: "tokens", model: "gpt-5" }
  });
});

test("automatic payloads contain only safe summaries", () => {
  assert.deepEqual(normalizeAutoStatusInput("song", {
    track: "Night Drive",
    artist: "Eva FM",
    album: "Sensitive Album",
    url: "https://private.example/track",
    service: "Spotify",
    playing: true
  }), {
    kind: "song",
    title: "Night Drive",
    details: "",
    source: "auto:music",
    isPublic: false,
    syncKey: "auto:music",
    meta: { track: "Night Drive", artist: "Eva FM", service: "Spotify", playing: true }
  });
  assert.deepEqual(normalizeAutoStatusInput("token", { usagePercent: 42, usedTokens: 123456, limitTokens: 456789, model: "private-model" }), {
    kind: "token",
    title: "Token usage",
    details: "",
    source: "auto:token",
    isPublic: false,
    syncKey: "auto:token",
    meta: { usagePercent: 42, unit: "%" }
  });
});

test("status publisher rejects an empty title", () => {
  assert.throws(() => normalizeStatusInput({ title: "   " }), /Status title is required/);
});
