import { test } from "node:test";
import assert from "node:assert/strict";
import { diffScene, emptyDiff, planScene } from "../../src/engine/scene.js";

const base = () => ({
  canvas: { width: 1920, height: 1080, fps: 60 },
  sources: [
    { id: "game", kind: "game" },
    { id: "cam", kind: "camera", device: "Cam Link 4K:\\\\?\\usb" },
    { id: "mic", kind: "mic", device: "default" },
    { id: "ov", kind: "overlay", url: "https://beta.whoslive.io/studio/overlay?k=1" },
  ],
  layers: [
    { id: "L-game", source: "game", x: 0, y: 0, w: 1920, h: 1080 },
    { id: "L-cam", source: "cam", x: 1500, y: 700, w: 400, h: 360, fit: "cover" },
    { id: "L-mic", source: "mic", x: 0, y: 0, w: 10, h: 10 }, // sound-only: never drawn
    { id: "L-ov", source: "ov", x: 0, y: 0, w: 1920, h: 1080 },
  ],
});

test("plan: sources become OBS inputs, sound-only sources get no layer", () => {
  const p = planScene(base());
  assert.equal(p.inputs.size, 4);
  assert.deepEqual(p.layers.map((l) => l.id), ["L-game", "L-cam", "L-ov"]);
});

test("first scene: everything is created", () => {
  const d = diffScene(null, planScene(base()));
  assert.equal(d.canvasChanged, true);
  assert.equal(d.createInputs.length, 4);
  assert.equal(d.addLayers.length, 3);
});

test("moving a layer only updates its transform; the camera isn't restarted", () => {
  const a = planScene(base());
  const s = base();
  s.layers[1].x = 1400;
  const d = diffScene(a, planScene(s));
  assert.equal(d.updateLayers.length, 1);
  assert.equal(d.createInputs.length + d.recreateInputs.length + d.updateInputs.length, 0);
  assert.equal(d.removeLayers.length + d.addLayers.length, 0);
});

test("a new device is a settings update; a different kind recreates the source and its layers", () => {
  const a = planScene(base());
  const s = base();
  s.sources[1].device = "OBSBOT:\\\\?\\usb2";
  const d = diffScene(a, planScene(s));
  assert.equal(d.updateInputs.length, 1);
  assert.equal(d.updateInputs[0].settings.video_device_id, "OBSBOT:\\\\?\\usb2");
  const s2 = base();
  s2.sources[0] = { id: "game", kind: "display", monitor: "\\\\?\\DISPLAY1" };
  const d2 = diffScene(a, planScene(s2));
  assert.equal(d2.recreateInputs.length, 1);
  assert.deepEqual(d2.removeLayers, ["L-game"]);
  assert.deepEqual(d2.addLayers.map((l) => l.id), ["L-game"]);
});

test("unchanged scene: nothing to do; reorder is reported bottom to top", () => {
  const a = planScene(base());
  assert.equal(emptyDiff(diffScene(a, planScene(base()))), true);
  const s = base();
  s.layers = [s.layers[3], s.layers[0], s.layers[1]];
  assert.deepEqual(diffScene(a, planScene(s)).order, ["L-ov", "L-game", "L-cam"]);
});

test("removed sources and their layers go", () => {
  const a = planScene(base());
  const s = base();
  s.sources = s.sources.filter((x) => x.id !== "cam");
  s.layers = s.layers.filter((x) => x.source !== "cam");
  const d = diffScene(a, planScene(s));
  assert.deepEqual(d.removeInputs, ["cam"]);
  assert.deepEqual(d.removeLayers, ["L-cam"]);
});

test("unknown canvases fall back to 1080p60", () => {
  assert.deepEqual(planScene({ canvas: { width: 123, height: 45, fps: 7 } }).canvas, { width: 1920, height: 1080, fps: 60 });
  assert.deepEqual(planScene({ canvas: { width: 2560, height: 1440, fps: 30 } }).canvas, { width: 2560, height: 1440, fps: 30 });
});
