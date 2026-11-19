// Studio's program scene as an engine plan, and what changed between two plans. Pure (tested without OBS).
//
// Studio sends its whole active scene every time something changes (debounced on its side). The engine only
// touches what changed: a moved layer is a transform update, a renamed device is a settings update, and only a
// different kind of source is recreated (recreating restarts it, which makes a camera blink).
import { AUDIO_ONLY, changedSettings, sameType, toInput } from "./sources.js";
import { cleanLayer } from "./layout.js";

export const CANVASES = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
  // Vertical (TikTok, Shorts, Reels) and square.
  { width: 1080, height: 1920 },
  { width: 720, height: 1280 },
  { width: 1080, height: 1080 },
];
export const MAX_SOURCES = 64;
export const MAX_LAYERS = 64;

export function cleanCanvas(c) {
  const w = Math.round(Number(c?.width)), h = Math.round(Number(c?.height));
  const ok = CANVASES.find((x) => x.width === w && x.height === h) ?? CANVASES[1];
  const fps = [24, 25, 30, 48, 50, 60].includes(Math.round(Number(c?.fps))) ? Math.round(Number(c?.fps)) : 60;
  return { width: ok.width, height: ok.height, fps };
}

/** Studio's scene, checked and turned into OBS inputs and layers (bottom to top). */
export function planScene(scene) {
  const canvas = cleanCanvas(scene?.canvas);
  const inputs = new Map();
  for (const s of Array.isArray(scene?.sources) ? scene.sources.slice(0, MAX_SOURCES) : []) {
    const input = toInput(s, canvas);
    if (input && !inputs.has(input.id)) inputs.set(input.id, input);
  }
  const layers = [];
  const seen = new Set();
  for (const l of Array.isArray(scene?.layers) ? scene.layers.slice(0, MAX_LAYERS) : []) {
    const layer = cleanLayer(l);
    if (!layer || seen.has(layer.id)) continue;
    const input = inputs.get(layer.source);
    // A layer needs a source that has a picture; sound-only sources are never drawn.
    if (!input || AUDIO_ONLY.has(input.kind)) continue;
    seen.add(layer.id);
    layers.push(layer);
  }
  return { canvas, inputs, layers };
}

/**
 * What to do to go from `prev` to `next`: inputs to remove, create, recreate (different type) or update (settings),
 * layers to remove, add or move, and the final bottom-to-top order. `prev` null: everything is new.
 */
export function diffScene(prev, next) {
  const out = { canvasChanged: !prev || prev.canvas.width !== next.canvas.width || prev.canvas.height !== next.canvas.height || prev.canvas.fps !== next.canvas.fps, removeInputs: [], createInputs: [], recreateInputs: [], updateInputs: [], removeLayers: [], addLayers: [], updateLayers: [], order: next.layers.map((l) => l.id) };
  const before = prev?.inputs ?? new Map();
  for (const [id] of before) if (!next.inputs.has(id)) out.removeInputs.push(id);
  for (const [id, input] of next.inputs) {
    const old = before.get(id);
    if (!old) out.createInputs.push(input);
    else if (!sameType(old, input)) out.recreateInputs.push(input);
    else {
      const settings = changedSettings(old.settings, input.settings);
      if (settings || old.audio !== input.audio) out.updateInputs.push({ id, settings: settings ?? {}, audio: input.audio });
    }
  }
  const recreated = new Set(out.recreateInputs.map((i) => i.id));
  const oldLayers = new Map((prev?.layers ?? []).map((l) => [l.id, l]));
  const newLayers = new Map(next.layers.map((l) => [l.id, l]));
  for (const [id, l] of oldLayers) if (!newLayers.has(id) || newLayers.get(id).source !== l.source || recreated.has(l.source)) out.removeLayers.push(id);
  for (const [id, l] of newLayers) {
    const old = oldLayers.get(id);
    if (!old || old.source !== l.source || recreated.has(l.source)) out.addLayers.push(l);
    else if (JSON.stringify(old) !== JSON.stringify(l)) out.updateLayers.push(l);
  }
  return out;
}

/** True when nothing needs doing. */
export const emptyDiff = (d) =>
  !d.canvasChanged && !d.removeInputs.length && !d.createInputs.length && !d.recreateInputs.length && !d.updateInputs.length && !d.removeLayers.length && !d.addLayers.length && !d.updateLayers.length;
