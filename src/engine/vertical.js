// The vertical picture's main picture (Studio's "@program" layers), on the engine's second canvas. Pure (tested).
//
// OBS draws a nested scene at the size of the canvas it's drawn on (the vertical one), clipping what's outside it. So
// the main picture's copy (a private scene with the same sources as the main one) is laid out already placed: each main
// layer moved and scaled to where it lands inside the vertical layer's box, relative to the box's corner, and clipped
// to the box itself (clipLayer). The nested item then sits at the box, uncropped: OBS gives a nested scene a different
// size depending on which canvas asks, so a crop on the nested item (or a crop filter on it) cuts the wrong part, which
// the smoke test caught. The soft backdrop ("@program-blur") is the same drawn BLUR times smaller and scaled back up:
// OBS's own smooth scaling blurs it, like Studio's.

export const BLUR = 16;

const frac = (v) => Math.max(0, Math.min(0.9, Number(v) || 0));

/**
 * Where the main picture lands in the vertical layer's box, as a scale and an offset from the box's corner: the main
 * picture cropped by the layer's crop (fractions), fitted into the box by its fit (contain, cover or fill).
 */
export function programMap(layer, main) {
  const c = layer.crop ?? {};
  let l = frac(c.left), r = frac(c.right), t = frac(c.top), b = frac(c.bottom);
  if (l + r > 0.95) r = 0.95 - l;
  if (t + b > 0.95) b = 0.95 - t;
  const sx = main.width * l, sy = main.height * t;
  const sw = main.width * (1 - l - r), sh = main.height * (1 - t - b);
  let kx, ky;
  if (layer.fit === "fill") (kx = layer.w / sw), (ky = layer.h / sh);
  else kx = ky = layer.fit === "cover" ? Math.max(layer.w / sw, layer.h / sh) : Math.min(layer.w / sw, layer.h / sh);
  const dw = sw * kx, dh = sh * ky;
  return { kx, ky, ox: (layer.w - dw) / 2 - sx * kx, oy: (layer.h - dh) / 2 - sy * ky };
}

/** A main layer as it's laid out in the main picture's copy (blur: BLUR times smaller). */
export function programLayer(main, map, blur = false) {
  const d = blur ? BLUR : 1;
  return {
    ...main,
    x: (map.ox + main.x * map.kx) / d,
    y: (map.oy + main.y * map.ky) / d,
    w: Math.max(1, (main.w * map.kx) / d),
    h: Math.max(1, (main.h * map.ky) / d),
  };
}

/** The part of the copy that shows: from its corner, the box's size (BLUR times smaller for the backdrop). */
export function programRegion(layer, canvas, blur = false) {
  const d = blur ? BLUR : 1;
  return { w: Math.max(1, Math.min(layer.w, canvas.width * d)) / d, h: Math.max(1, Math.min(layer.h, canvas.height * d)) / d };
}

/**
 * A copied layer clipped to the copy's region (0, 0, w, h): where its picture shows inside the region, stretched
 * there, with the source cropped to just that part (fractions of the source, like Studio's own crop; mirrored for a
 * flipped layer). Null when none of it shows. Without the source's size yet, the layer as it is. Scale to sound is
 * left out of the copy (the main picture keeps it).
 */
export function clipLayer(layer, src, region) {
  if (!src || !(src.width > 0) || !(src.height > 0)) return layer;
  const c = layer.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cw = 1 - c.left - c.right, ch = 1 - c.top - c.bottom;
  const pw = src.width * cw, ph = src.height * ch;
  if (!(pw > 0) || !(ph > 0)) return layer;
  let kx, ky;
  if (layer.fit === "fill") (kx = layer.w / pw), (ky = layer.h / ph);
  else kx = ky = layer.fit === "cover" ? Math.max(layer.w / pw, layer.h / ph) : Math.min(layer.w / pw, layer.h / ph);
  const dw = pw * kx, dh = ph * ky;
  const dx = layer.x + (layer.w - dw) / 2, dy = layer.y + (layer.h - dh) / 2;
  let x0 = Math.max(dx, 0), y0 = Math.max(dy, 0), x1 = Math.min(dx + dw, region.w), y1 = Math.min(dy + dh, region.h);
  if (layer.fit === "cover") {
    x0 = Math.max(x0, layer.x);
    y0 = Math.max(y0, layer.y);
    x1 = Math.min(x1, layer.x + layer.w);
    y1 = Math.min(y1, layer.y + layer.h);
  }
  if (!(x1 - x0 > 0.5) || !(y1 - y0 > 0.5)) return null;
  let fl = (x0 - dx) / dw, fr = (dx + dw - x1) / dw, ft = (y0 - dy) / dh, fb = (dy + dh - y1) / dh;
  if (layer.flipX) [fl, fr] = [fr, fl];
  if (layer.flipY) [ft, fb] = [fb, ft];
  return {
    ...layer,
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    fit: "fill",
    sound: null,
    crop: { left: c.left + fl * cw, right: c.right + fr * cw, top: c.top + ft * ch, bottom: c.bottom + fb * ch },
  };
}

/** The nested copy's item in the vertical picture: at the box (scaled back up for the backdrop). */
export function programItem(layer, canvas, blur = false) {
  const d = blur ? BLUR : 1;
  const { w, h } = programRegion(layer, canvas, blur);
  return {
    position: { x: layer.x, y: layer.y },
    scale: { x: d, y: d },
    crop: { left: 0, top: 0, right: Math.max(0, Math.round(canvas.width - w)), bottom: Math.max(0, Math.round(canvas.height - h)) },
    visible: layer.visible !== false,
  };
}
