import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIGN, BOUNDS, cleanLayer, cleanSound, fittedRect, itemTransform, levelToFactor, smoothFactor } from "../../src/engine/layout.js";

const layer = (o = {}) => cleanLayer({ id: "l1", source: "cam", x: 100, y: 50, w: 400, h: 400, ...o });

test("contain, cover and fill are OBS bounding boxes anchored top-left", () => {
  const t = itemTransform(layer());
  assert.equal(t.boundsType, BOUNDS.inner);
  assert.deepEqual(t.position, { x: 100, y: 50 });
  assert.deepEqual(t.bounds, { x: 400, y: 400 });
  assert.equal(t.alignment, ALIGN.left | ALIGN.top);
  assert.equal(itemTransform(layer({ fit: "cover" })).boundsType, BOUNDS.outer);
  assert.equal(itemTransform(layer({ fit: "cover" })).cropToBounds, true);
  assert.equal(itemTransform(layer({ fit: "fill" })).boundsType, BOUNDS.stretch);
});

test("flips are a negative scale; crop is in the source's own pixels", () => {
  const t = itemTransform(layer({ flipX: true, crop: { left: 0.1, right: 0.1 } }), { width: 1920, height: 1080 });
  assert.deepEqual(t.scale, { x: -1, y: 1 });
  assert.equal(t.crop.left, 192);
  assert.equal(t.crop.right, 192);
  assert.equal(itemTransform(layer({ crop: { left: 0.1 } })).crop.left, 0); // size unknown yet
});

test("a 16:9 picture letterboxes inside a square box", () => {
  const r = fittedRect(layer(), { width: 1920, height: 1080 });
  assert.equal(r.w, 400);
  assert.equal(r.h, 225);
  assert.equal(r.y, 50 + (400 - 225) / 2);
});

test("Scale to sound, his OBS settings: height only, center/bottom, the bottom edge stays put", () => {
  const sound = cleanSound({ on: true, from: "mic", quiet: -64, loud: -49, minScale: 79, maxScale: 100, scaleWidth: false, scaleHeight: true, alignX: "center", alignY: "bottom", attack: 0, release: 0 });
  const l = layer({ sound: { on: true, from: "mic", quiet: -64, loud: -49, minScale: 79, maxScale: 100, scaleWidth: false, scaleHeight: true, alignX: "center", alignY: "bottom", attack: 0, release: 0 } });
  assert.equal(levelToFactor(-70, sound), 0.79);
  assert.equal(levelToFactor(-45, sound), 1);
  const src = { width: 1000, height: 1000 };
  const quiet = itemTransform(l, src, 0.79);
  assert.equal(quiet.alignment, ALIGN.bottom);
  assert.deepEqual(quiet.position, { x: 300, y: 450 }); // bottom-center of the fitted picture
  assert.equal(quiet.bounds.x, 400); // width untouched
  assert.ok(Math.abs(quiet.bounds.y - 316) < 1e-9);
  assert.equal(quiet.boundsType, BOUNDS.stretch);
  const loud = itemTransform(l, src, 1);
  assert.deepEqual(loud.position, quiet.position);
  assert.equal(loud.bounds.y, 400);
});

test("width scaling stretches side to side; inverse makes loud small", () => {
  const l = layer({ sound: { on: true, from: "mic", scaleWidth: true, scaleHeight: false, alignX: "left", alignY: "top" } });
  const t = itemTransform(l, { width: 400, height: 400 }, 1.5);
  assert.equal(t.bounds.x, 600);
  assert.equal(t.bounds.y, 400);
  assert.equal(t.alignment, ALIGN.left | ALIGN.top);
  const inv = cleanSound({ on: true, inverse: true, minScale: 50, maxScale: 100, quiet: -60, loud: -20 });
  assert.equal(levelToFactor(-10, inv), 0.5);
});

test("smoothing: attack while growing, release while shrinking, 0 is instant", () => {
  const s = cleanSound({ on: true, attack: 0, release: 100 });
  assert.equal(smoothFactor(1, 1.2, 33, s), 1.2);
  const down = smoothFactor(1.2, 1, 33, s);
  assert.ok(down < 1.2 && down > 1);
});

test("bad layers are refused", () => {
  assert.equal(cleanLayer({ id: "x", source: "y", w: 0, h: 10 }), null);
  assert.equal(cleanLayer({ id: "has space", source: "y", w: 10, h: 10 }), null);
  assert.equal(cleanSound({ on: false }), null);
});
