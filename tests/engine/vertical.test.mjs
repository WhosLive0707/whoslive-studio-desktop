import assert from "node:assert/strict";
import test from "node:test";
import { BLUR, clipLayer, programItem, programLayer, programMap, programRegion } from "../../src/engine/vertical.js";

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

test("copied layers are clipped to the part of the copy that shows", () => {
  const region = { w: 1080, h: 608 };
  const zero = { left: 0, top: 0, right: 0, bottom: 0 };
  const src = { width: 1920, height: 1080 };
  // Inside the region: unchanged picture, as a stretched layer the same size.
  const inside = clipLayer({ id: "a", source: "s", x: 0, y: 0, w: 1080, h: 607.5, fit: "contain", crop: zero }, src, region);
  near(inside.x, 0);
  near(inside.w, 1080);
  near(inside.h, 607.5);
  near(inside.crop.left + inside.crop.right, 0);
  // Half past the right edge: the left half shows, the source's right half is cropped off.
  const half = clipLayer({ id: "b", source: "s", x: 540, y: 0, w: 1080, h: 607.5, fit: "fill", crop: zero }, src, region);
  near(half.x, 540);
  near(half.w, 540);
  near(half.crop.right, 0.5);
  near(half.crop.left, 0);
  // Flipped, the drawn left half is the source's right half: its left is cropped instead.
  const flipped = clipLayer({ id: "c", source: "s", x: 540, y: 0, w: 1080, h: 607.5, fit: "fill", flipX: true, crop: zero }, src, region);
  near(flipped.crop.left, 0.5);
  near(flipped.crop.right, 0);
  // Cover: the picture outside its own box never shows; a 1:1 box of a 16:9 source keeps its middle.
  const cover = clipLayer({ id: "d", source: "s", x: 0, y: 0, w: 400, h: 400, fit: "cover", crop: zero }, src, region);
  near(cover.w, 400);
  near(cover.crop.left, (1 - 1080 / 1920) / 2);
  near(cover.crop.right, (1 - 1080 / 1920) / 2);
  assert.equal(cover.fit, "fill");
  // Nothing inside: null. No size yet: the layer as it is.
  assert.equal(clipLayer({ id: "e", source: "s", x: 2000, y: 0, w: 100, h: 100, fit: "fill", crop: zero }, src, region), null);
  const l = { id: "f", source: "s", x: 0, y: 0, w: 10, h: 10, fit: "fill", crop: zero };
  assert.equal(clipLayer(l, null, region), l);
  // The backdrop's region is BLUR times smaller.
  assert.deepEqual(programRegion({ x: 0, y: 0, w: 1080, h: 1920 }, { width: 1080, height: 1920 }, true), { w: 1080 / BLUR, h: 1920 / BLUR });
});
