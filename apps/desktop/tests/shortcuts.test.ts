import test from "node:test";
import assert from "node:assert/strict";
import { resolveShortcut, type ShortcutEvent } from "../src/lib/shortcuts.js";

const event = (overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: "1", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, targetIsEditable: false, ...overrides,
});

test("Command and Control digits navigate all six sections, including inside forms", () => {
  const paths = ["/", "/route", "/sources", "/routing", "/activity", "/settings"];
  for (const metaKey of [true, false]) {
    for (const targetIsEditable of [true, false]) {
      paths.forEach((path, index) => assert.deepEqual(resolveShortcut(event({
        key: String(index + 1), metaKey, ctrlKey: !metaKey, targetIsEditable,
      })), { type: "navigate", path }));
    }
  }
});

test("Command and Control Enter toggle only outside editable fields", () => {
  for (const metaKey of [true, false]) {
    assert.deepEqual(resolveShortcut(event({ key: "Enter", metaKey, ctrlKey: !metaKey })),
      { type: "toggleConnection" });
    assert.equal(resolveShortcut(event({ key: "Enter", metaKey, ctrlKey: !metaKey, targetIsEditable: true })), null);
  }
});

test("unmodified keys, Alt, Shift, and unrelated keys are ignored", () => {
  for (const key of ["1", "Enter"]) {
    assert.equal(resolveShortcut(event({ key, metaKey: false })), null);
    assert.equal(resolveShortcut(event({ key, altKey: true })), null);
    assert.equal(resolveShortcut(event({ key, shiftKey: true })), null);
  }
  for (const key of ["0", "7", "a", "Escape"]) assert.equal(resolveShortcut(event({ key })), null);
});
