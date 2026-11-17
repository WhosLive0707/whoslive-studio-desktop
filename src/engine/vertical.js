// The vertical picture's main picture (Studio's "@program" layers), on the engine's second canvas. Pure (tested).
//
// OBS draws a nested scene at the size of the canvas it's drawn on (the vertical one), clipping what's outside it. So
// the main picture's copy (a private scene with the same sources as the main one) is laid out already placed: each main
// layer moved and scaled to where it lands inside the vertical layer's box, relative to the box's corner. The nested
// item then sits at the box, cropped to it. The soft backdrop ("@program-blur") is the same drawn BLUR times smaller and
// scaled back up: OBS's own smooth scaling blurs it, like Studio's.

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

/** The nested copy's item in the vertical picture: at the box, cropped to it (scaled back up for the backdrop). */
export function programItem(layer, canvas, blur = false) {
  const d = blur ? BLUR : 1;
  const w = Math.max(1, Math.min(layer.w, canvas.width * d)) / d;
  const h = Math.max(1, Math.min(layer.h, canvas.height * d)) / d;
  return {
    position: { x: layer.x, y: layer.y },
    scale: { x: d, y: d },
    crop: { left: 0, top: 0, right: Math.max(0, Math.round(canvas.width - w)), bottom: Math.max(0, Math.round(canvas.height - h)) },
    visible: layer.visible !== false,
  };
}
