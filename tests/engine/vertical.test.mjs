import assert from "node:assert/strict";
import test from "node:test";
import { BLUR, programItem, programLayer, programMap } from "../../src/engine/vertical.js";

const main = { width: 1920, height: 1080 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("the main picture fitted into the vertical box: contain, cover, fill, with the layer's crop", () => {
  // 1080 wide box, 608 tall at y=656: contain is 1080/1920 both ways, centred.
  const c = programMap({ x: 0, y: 656, w: 1080, h: 608, fit: "contain" }, main);
  near(c.kx, 0.5625);
  near(c.ky, 0.5625);
  near(c.ox, 0);
  near(c.oy, (608 - 607.5) / 2);
  // Cover a 1080x1920 box: height decides (1920/1080), the sides are cut off evenly.
  const v = programMap({ x: 0, y: 0, w: 1080, h: 1920, fit: "cover" }, main);
  near(v.kx, 1920 / 1080);
  near(v.ox, (1080 - 1920 * (1920 / 1080)) / 2);
  near(v.oy, 0);
  // Fill stretches each way; a crop of the left half shows only the right half.
  const f = programMap({ x: 0, y: 0, w: 1000, h: 500, fit: "fill", crop: { left: 0.5, right: 0, top: 0, bottom: 0 } }, main);
  near(f.kx, 1000 / 960);
  near(f.ky, 500 / 1080);
  near(f.ox, -960 * f.kx);
});

test("main layers in the copy land where they show in the box; the backdrop's copy is BLUR times smaller", () => {
  const map = programMap({ x: 0, y: 656, w: 1080, h: 608, fit: "contain" }, main);
  const cam = programLayer({ id: "L-cam", source: "cam", x: 1440, y: 810, w: 480, h: 270, fit: "cover" }, map);
  near(cam.x, 810);
  near(cam.w, 270);
  assert.equal(cam.source, "cam");
  assert.equal(cam.fit, "cover");
  const blur = programLayer({ id: "L-cam", source: "cam", x: 1440, y: 810, w: 480, h: 270 }, map, true);
  near(blur.x, 810 / BLUR);
  near(blur.w, 270 / BLUR);
});

test("the copy's item sits at the box, cropped to it; the backdrop is scaled back up", () => {
  const canvas = { width: 1080, height: 1920 };
  const it = programItem({ x: 0, y: 656, w: 1080, h: 608 }, canvas);
  assert.deepEqual(it.position, { x: 0, y: 656 });
  assert.deepEqual(it.scale, { x: 1, y: 1 });
  assert.deepEqual(it.crop, { left: 0, top: 0, right: 0, bottom: 1312 });
  const b = programItem({ x: 0, y: 0, w: 1080, h: 1920 }, canvas, true);
  assert.deepEqual(b.scale, { x: BLUR, y: BLUR });
  assert.deepEqual(b.crop, { left: 0, top: 0, right: Math.round(1080 - 1080 / BLUR), bottom: Math.round(1920 - 1920 / BLUR) });
});
