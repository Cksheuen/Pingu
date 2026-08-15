import test from "node:test";
import assert from "node:assert/strict";
import { createLocale, detectLocale, describeLocalizedStatus } from "../src/services/locale";

test("locale defaults to Chinese only for Chinese browser languages and persists a manual selection", () => {
  const values = new Map<string, string>();
  // 仅实现 createLocale 用到的 getItem/setItem，按 Storage 结构做最小 mock
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as unknown as Storage;
  assert.equal(detectLocale("zh-CN"), "zh");
  assert.equal(detectLocale("en-GB"), "en");

  const locale = createLocale({ browserLanguage: "zh-TW", storage });
  assert.equal(locale.language, "zh");
  assert.equal(locale.t("nav.gallery"), "画稿簿");
  locale.setLanguage("en");

  const restored = createLocale({ browserLanguage: "zh-CN", storage });
  assert.equal(restored.language, "en");
});

test("localized public statuses keep authored signal values intact", () => {
  const locale = createLocale({ browserLanguage: "zh-CN", storage: null });
  assert.equal(describeLocalizedStatus({ kind: "song", title: "Night Drive", meta: { track: "Night Drive", artist: "Eva FM" } }, locale), "正在听: Night Drive · Eva FM");
  assert.equal(describeLocalizedStatus({ kind: "token", title: "Token usage", meta: { usagePercent: 42 } }, locale), "Token 使用情况: 42%");
});
