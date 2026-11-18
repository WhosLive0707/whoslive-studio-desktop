// Studio's layers as OBS scene item transforms, and Scale to sound done natively. Pure (tested without OBS).
//
// A layer is a box on the canvas (x, y, w, h) that its source is fitted into: contain (letterboxed), cover (filled
// and cropped to the box) or fill (stretched). OBS does exactly that with a bounding box, so normal layers are
// bounding-box items anchored at their top-left corner, and flips are a negative scale (OBS keeps a flipped item
// inside its box). Scale to sound stretches the fitted picture itself around its anchor, like the OBS plugin.

/** OBS alignment flags. */
export const ALIGN = { center: 0, left: 1, right: 2, top: 4, bottom: 8 };
/** OBS bounding box types. */
export const BOUNDS = { none: 0, stretch: 1, inner: 2, outer: 3 };

const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const frac = (v) => Math.max(0, Math.min(0.95, num(v)));

/** The layer, checked. Null when it can't be drawn. */
export function cleanLayer(l) {
  if (!l || typeof l !== "object") return null;
  const id = typeof l.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(l.id) ? l.id : null;
  const source = typeof l.source === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(l.source) ? l.source : null;
  const w = num(l.w), h = num(l.h);
  if (!id || !source || !(w > 0) || !(h > 0)) return null;
  const fit = l.fit === "cover" || l.fit === "fill" ? l.fit : "contain";
  const c = l.crop && typeof l.crop === "object" ? l.crop : {};
  return {
    id,
    source,
    x: num(l.x),
    y: num(l.y),
    w,
    h,
    fit,
    crop: { left: frac(c.left), top: frac(c.top), right: frac(c.right), bottom: frac(c.bottom) },
    flipX: l.flipX === true,
    flipY: l.flipY === true,
    visible: l.visible !== false,
    opacity: Math.max(0, Math.min(1, num(l.opacity, 1))),
    sound: cleanSound(l.sound),
  };
}

/** Scale to sound, as Studio saves it (scale-to-sound.logic SoundCfg). Null when off or unusable. */
export function cleanSound(v) {
  if (!v || typeof v !== "object" || v.on !== true) return null;
  const minScale = Math.max(0, Math.min(200, num(v.minScale, 100)));
  const maxScale = Math.max(minScale, Math.min(200, num(v.maxScale, 115)));
  let quiet = Math.max(-90, Math.min(0, num(v.quiet, -45)));
  let loud = Math.max(-90, Math.min(0, num(v.loud, -12)));
  if (loud < quiet) [quiet, loud] = [loud, quiet];
  else if (loud === quiet) loud = Math.min(0, quiet + 1);
  if (loud === quiet) quiet = loud - 1; // both at 0 dB
  const from = typeof v.from === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(v.from) ? v.from : "mic";
  return {
    from,
    minScale,
    maxScale,
    quiet,
    loud,
    inverse: v.inverse === true,
    scaleWidth: v.scaleWidth !== false,
    scaleHeight: v.scaleHeight !== false,
    alignX: v.alignX === "left" || v.alignX === "right" ? v.alignX : "center",
    alignY: v.alignY === "top" || v.alignY === "center" ? v.alignY : "bottom",
    attack: Math.max(0, Math.min(2000, num(v.attack, 40))),
    release: Math.max(0, Math.min(5000, num(v.release, 160))),
  };
}

/** The picture's rectangle inside the layer box for this fit (cover and fill fill the box). */
export function fittedRect(layer, src) {
  const box = { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
  if (layer.fit !== "contain" || !src || !(src.width > 0) || !(src.height > 0)) return box;
  const cw = src.width * (1 - layer.crop.left - layer.crop.right);
  const ch = src.height * (1 - layer.crop.top - layer.crop.bottom);
  if (!(cw > 0) || !(ch > 0)) return box;
  const s = Math.min(layer.w / cw, layer.h / ch);
  const w = cw * s, h = ch * s;
  return { x: layer.x + (layer.w - w) / 2, y: layer.y + (layer.h - h) / 2, w, h };
}

/** Crop in source pixels (OBS crops in the source's own pixels). Zero until the source's size is known. */
export function cropPixels(layer, src) {
  if (!src || !(src.width > 0) || !(src.height > 0)) return { left: 0, top: 0, right: 0, bottom: 0 };
  const r = (f, n) => Math.round(f * n);
  return { left: r(layer.crop.left, src.width), top: r(layer.crop.top, src.height), right: r(layer.crop.right, src.width), bottom: r(layer.crop.bottom, src.height) };
}

/**
 * The scene item transform for a layer. `src`: the source's size when known ({ width, height }). `factor`: Scale to
 * sound's current factor (1 = the layer's own size), only used when the layer has sound scaling.
 */
export function itemTransform(layer, src, factor = 1) {
  const sign = { x: layer.flipX ? -1 : 1, y: layer.flipY ? -1 : 1 };
  const crop = cropPixels(layer, src);
  if (layer.sound) {
    // Stretch the fitted picture around its anchor: width only, height only, or both, like OBS's Scale to Sound.
    const r = fittedRect(layer, src);
    const sx = layer.sound.scaleWidth ? factor : 1;
    const sy = layer.sound.scaleHeight ? factor : 1;
    const ax = layer.sound.alignX === "left" ? 0 : layer.sound.alignX === "right" ? 1 : 0.5;
    const ay = layer.sound.alignY === "top" ? 0 : layer.sound.alignY === "bottom" ? 1 : 0.5;
    return {
      position: { x: r.x + r.w * ax, y: r.y + r.h * ay },
      alignment: (ax === 0 ? ALIGN.left : ax === 1 ? ALIGN.right : 0) | (ay === 0 ? ALIGN.top : ay === 1 ? ALIGN.bottom : 0),
      boundsType: layer.fit === "cover" ? BOUNDS.outer : BOUNDS.stretch,
      bounds: { x: Math.max(1, r.w * sx), y: Math.max(1, r.h * sy) },
      boundsAlignment: ALIGN.center,
      cropToBounds: layer.fit === "cover",
      scale: sign,
      crop,
      visible: layer.visible && factor > 0.001,
    };
  }
  return {
    position: { x: layer.x, y: layer.y },
    alignment: ALIGN.left | ALIGN.top,
    boundsType: layer.fit === "fill" ? BOUNDS.stretch : layer.fit === "cover" ? BOUNDS.outer : BOUNDS.inner,
    bounds: { x: layer.w, y: layer.h },
    boundsAlignment: ALIGN.center,
    cropToBounds: layer.fit === "cover",
    scale: sign,
    crop,
    visible: layer.visible,
  };
}

/** The factor (1 = the layer's own size) a level gives: minScale at or below quiet, maxScale at or above loud. */
export function levelToFactor(db, s) {
  const t = Math.min(1, Math.max(0, (db - s.quiet) / (s.loud - s.quiet || 1)));
  return (s.minScale + (s.maxScale - s.minScale) * (s.inverse ? 1 - t : t)) / 100;
}

/** One smoothing step towards target over dtMs: attack while growing, release while shrinking (exponential). */
export function smoothFactor(cur, target, dtMs, s) {
  const tau = target > cur ? s.attack : s.release;
  if (!(tau > 0) || !(dtMs > 0)) return target;
  return cur + (target - cur) * (1 - Math.exp(-dtMs / tau));
}

/** Two transforms are the same (within a quarter pixel): nothing to send to OBS. */
export function sameTransform(a, b) {
  if (!a || !b) return false;
  const near = (p, q) => Math.abs(p - q) < 0.25;
  return (
    near(a.position.x, b.position.x) && near(a.position.y, b.position.y) &&
    near(a.bounds.x, b.bounds.x) && near(a.bounds.y, b.bounds.y) &&
    a.alignment === b.alignment && a.boundsType === b.boundsType && a.boundsAlignment === b.boundsAlignment &&
    a.cropToBounds === b.cropToBounds && a.scale.x === b.scale.x && a.scale.y === b.scale.y && a.visible === b.visible &&
    a.crop.left === b.crop.left && a.crop.top === b.crop.top && a.crop.right === b.crop.right && a.crop.bottom === b.crop.bottom
  );
}
