// The native engine: OBS's engine (libobs, through obs-studio-node) in its own process.
//
// Runs as an Electron utility process (client.js starts it), so OBS's synchronous calls never block the app's
// window. OBS itself runs one more process down (obs64.exe, which obs-studio-node starts and talks to), so a crash
// in a capture driver or encoder takes down the engine, never Studio's window: client.js restarts it.
//
// Messages in: { id, type, args } (see HANDLERS). Replies: { id, ok, result | error }. Events out: { event, data }.
import path from "node:path";
import { encoderInfo, encoderSettings, pickEncoder } from "./encoders.js";
import { itemTransform, levelToFactor, sameTransform, smoothFactor } from "./layout.js";
import { diffScene, emptyDiff, planScene } from "./scene.js";
import { RelayLink } from "./relay.js";

/* global require */
// Only ever runs bundled (dist/engine-host.cjs, CommonJS); obs-studio-node is loaded from its own folder at run time.
const req = require;
const parent = process.parentPort;

/** OBS enum values (obs-studio-node's const enums don't exist at runtime). */
const OBS = {
  success: 0,
  videoFormatNV12: 2,
  colorspace709: 2,
  rangePartial: 1,
  scaleBicubic: 2,
  fpsInteger: 1,
  faderIEC: 1,
  monitor: { off: 0, only: 1, output: 2 },
  renderMain: 0,
  // ESourceOutputFlags: the source makes sound.
  outputAudio: 1 << 1,
};

const st = {
  osn: null,
  dir: "",
  ctx: null, // the program's video context
  scene: null,
  transition: null,
  plan: null,
  inputs: new Map(), // studio id -> IInput
  items: new Map(), // layer id -> { item, layer, last }
  filters: new Map(), // layer id -> opacity filter
  volmeters: new Map(), // studio id -> IVolmeter
  levels: new Map(), // studio id -> dB (magnitude)
  sizes: new Map(), // studio id -> { width, height }
  factors: new Map(), // layer id -> current Scale to sound factor
  display: null, // preview display name
  out: null, // { streaming, encoder, service, audioTrack, link, info, kbps, url, stopping }
  failedEncoders: [],
  timers: [],
};

const emit = (event, data) => parent.postMessage({ event, data });
const log = (stage, level, msg) => emit("log", { stage, level, msg: String(msg).slice(0, 500) });
const obsName = (id) => `wl-${id}`;
const fromObsName = (n) => (typeof n === "string" && n.startsWith("wl-") ? n.slice(3) : null);

/* ---------------- start and stop ---------------- */

function init({ dir, appData, version }) {
  if (st.osn) return { ready: true, encoders: st.osn.VideoEncoderFactory.types() };
  st.dir = dir;
  const osn = req(path.join(dir, "index.js"));
  osn.IPC.host(`whoslive-engine-${process.pid}-${Date.now()}`);
  osn.NodeObs.SetWorkingDirectory(dir);
  const code = osn.NodeObs.OBS_API_initAPI({ language: "en-US", appDataPath: appData, version: String(version || "0"), crashServerUrl: "" });
  if (code !== OBS.success) {
    try {
      osn.NodeObs.InitShutdownSequence();
      osn.IPC.disconnect();
    } catch {
      /* already down */
    }
    throw new Error(initError(code));
  }
  st.osn = osn;
  osn.NodeObs.RegisterVolmeterCallback(onLevels);
  st.ctx = osn.VideoFactory.create();
  setCanvas({ width: 1920, height: 1080, fps: 60 });
  st.scene = osn.SceneFactory.create("wl-program");
  st.transition = osn.TransitionFactory.create("cut_transition", "wl-transition");
  st.transition.set(st.scene);
  osn.Global.setOutputSource(0, st.transition);
  // Scale to sound and source sizes (letterboxing needs each source's real size, which a camera only has once it runs).
  st.timers.push(setInterval(soundTick, 33));
  st.timers.push(setInterval(sizeTick, 500));
  st.timers.push(setInterval(statsTick, 1000));
  return { ready: true, encoders: osn.VideoEncoderFactory.types() };
}

function initError(code) {
  if (code === -2) return "Your graphics card or driver can't run the engine (DirectX 11 is needed). Update your graphics driver.";
  if (code === -5) return "Part of the engine is missing. Reinstall WhosLive Studio.";
  return `The engine couldn't start (code ${code}).`;
}

function shutdown() {
  for (const t of st.timers) clearInterval(t);
  st.timers = [];
  try {
    stopOutput(true);
  } catch {
    /* going down */
  }
  const osn = st.osn;
  if (!osn) return { ok: true };
  try {
    if (st.display) osn.NodeObs.OBS_content_destroyDisplay(st.display);
    for (const v of st.volmeters.values()) v.destroy();
    for (const { item } of st.items.values()) item.remove();
    for (const i of st.inputs.values()) i.release();
    osn.Global.setOutputSource(0, null);
    st.transition?.release();
    st.scene?.release();
    st.ctx?.destroy();
    osn.NodeObs.RemoveVolmeterCallback();
    osn.NodeObs.InitShutdownSequence();
    osn.IPC.disconnect();
  } catch (e) {
    log("shutdown", "error", e?.message ?? e);
  }
  st.osn = null;
  return { ok: true };
}

/* ---------------- video ---------------- */

function setCanvas({ width, height, fps }, outSize) {
  st.ctx.video = {
    fpsNum: fps,
    fpsDen: 1,
    baseWidth: width,
    baseHeight: height,
    outputWidth: outSize?.width ?? width,
    outputHeight: outSize?.height ?? height,
    outputFormat: OBS.videoFormatNV12,
    colorspace: OBS.colorspace709,
    range: OBS.rangePartial,
    scaleType: OBS.scaleBicubic,
    fpsType: OBS.fpsInteger,
  };
}

/* ---------------- devices ---------------- */

/** Every camera/capture card, mic/line-in, speaker, monitor, window and app with sound, by the names Windows uses. */
function devices() {
  const osn = st.osn;
  const list = (fn) => {
    try {
      return (osn.NodeObs[fn]() ?? []).map((d) => ({ id: String(d.id), name: String(d.description) }));
    } catch {
      return [];
    }
  };
  const fromProp = (type, prop) => {
    let input = null;
    try {
      input = osn.InputFactory.create(type, `wl-enum-${type}-${Date.now()}`, {});
      const p = input.properties.get(prop);
      return (p?.details?.items ?? []).filter((i) => i.value !== "" && i.value !== undefined).map((i) => ({ id: String(i.value), name: String(i.name) }));
    } catch {
      return [];
    } finally {
      try {
        input?.release();
      } catch {
        /* ignore */
      }
    }
  };
  return {
    cameras: list("OBS_settings_getVideoDevices"),
    mics: list("OBS_settings_getInputAudioDevices"),
    speakers: list("OBS_settings_getOutputAudioDevices"),
    monitors: fromProp("monitor_capture", "monitor_id"),
    windows: fromProp("window_capture", "window"),
    games: fromProp("game_capture", "window"),
    apps: fromProp("wasapi_process_output_capture", "window"),
    encoders: osn.VideoEncoderFactory.types().map((id) => encoderInfo(id)).filter((e) => e.vendor !== "unknown"),
  };
}

/* ---------------- the scene ---------------- */

function setScene(scene) {
  const osn = st.osn;
  const next = planScene(scene);
  const d = diffScene(st.plan, next);
  if (emptyDiff(d) && sameOrder(d.order)) return { changed: false };
  if (d.canvasChanged) {
    // A live stream keeps the picture it started with (the platforms need one resolution).
    if (st.out) next.canvas = st.plan?.canvas ?? next.canvas;
    else setCanvas(next.canvas);
  }
  for (const id of d.removeLayers) removeLayer(id);
  for (const id of d.removeInputs) removeInput(id);
  for (const input of d.recreateInputs) {
    for (const [lid, it] of st.items) if (it.layer.source === input.id) removeLayer(lid);
    removeInput(input.id);
    createInput(osn, input);
  }
  for (const input of d.createInputs) createInput(osn, input);
  for (const u of d.updateInputs) {
    const i = st.inputs.get(u.id);
    if (!i) continue;
    if (Object.keys(u.settings).length) i.update(u.settings);
    if (u.audio !== undefined && next.inputs.get(u.id)?.kind === "camera") i.muted = !u.audio;
  }
  for (const l of d.addLayers) addLayer(l);
  for (const l of d.updateLayers) {
    const it = st.items.get(l.id);
    if (!it) continue;
    it.layer = l;
    applyTransform(it, true);
    setOpacity(l);
  }
  st.plan = next;
  reorder(d.order);
  return { changed: true };
}

function createInput(osn, input) {
  try {
    const i = osn.InputFactory.create(input.obsId, obsName(input.id), input.settings);
    if (input.kind === "camera") i.muted = !input.audio;
    st.inputs.set(input.id, i);
    if (i.outputFlags & OBS.outputAudio) {
      const v = osn.VolmeterFactory.create(OBS.faderIEC);
      v.attach(i);
      st.volmeters.set(input.id, v);
    }
  } catch (e) {
    log("source", "error", `${input.kind}: ${e?.message ?? e}`);
    emit("source-error", { id: input.id, kind: input.kind, message: "This source couldn't start in the engine." });
  }
}

function removeInput(id) {
  st.volmeters.get(id)?.destroy();
  st.volmeters.delete(id);
  st.levels.delete(id);
  st.sizes.delete(id);
  try {
    st.inputs.get(id)?.release();
  } catch {
    /* already gone */
  }
  st.inputs.delete(id);
}

function addLayer(layer) {
  const input = st.inputs.get(layer.source);
  if (!input) return;
  const item = st.scene.add(input);
  try {
    item.video = st.ctx;
  } catch {
    /* a single-canvas build of obs-studio-node renders every item on its one canvas */
  }
  const it = { item, layer, last: null };
  st.items.set(layer.id, it);
  applyTransform(it, true);
  setOpacity(layer);
}

function removeLayer(id) {
  const it = st.items.get(id);
  if (!it) return;
  try {
    it.item.remove();
  } catch {
    /* already gone */
  }
  st.items.delete(id);
  st.filters.delete(id);
  st.factors.delete(id);
}

function sameOrder(order) {
  const items = st.scene?.getItems?.() ?? [];
  const now = items.map((i) => [...st.items].find(([, it]) => it.item.id === i.id)?.[0]).filter(Boolean);
  return now.length === order.length && now.every((id, n) => id === order[n]);
}

/** Bottom to top, as Studio lists its layers. */
function reorder(order) {
  if (sameOrder(order)) return;
  order.forEach((id, n) => {
    const it = st.items.get(id);
    try {
      it?.item.move(n);
    } catch {
      /* removed meanwhile */
    }
  });
}

function applyTransform(it, force = false) {
  const size = st.sizes.get(it.layer.source);
  const factor = it.layer.sound ? (st.factors.get(it.layer.id) ?? 1) : 1;
  const t = itemTransform(it.layer, size, factor);
  if (!force && sameTransform(it.last, t)) return;
  const item = it.item;
  item.deferUpdateBegin();
  try {
    item.alignment = t.alignment;
    item.boundsType = t.boundsType;
    item.bounds = t.bounds;
    item.boundsAlignment = t.boundsAlignment;
    item.cropToBounds = t.cropToBounds;
    item.scale = t.scale;
    item.position = t.position;
    item.crop = t.crop;
    item.visible = t.visible;
  } finally {
    item.deferUpdateEnd();
  }
  it.last = t;
}

/** Layer opacity: OBS's Color Correction filter, only on layers that aren't fully opaque. */
function setOpacity(layer) {
  const input = st.inputs.get(layer.source);
  if (!input) return;
  let f = st.filters.get(layer.id);
  if (layer.opacity >= 0.999) {
    if (f) {
      input.removeFilter(f);
      f.release();
      st.filters.delete(layer.id);
    }
    return;
  }
  if (!f) {
    f = st.osn.FilterFactory.create("color_filter_v2", `wl-opacity-${layer.id}`, { opacity: layer.opacity });
    input.addFilter(f);
    st.filters.set(layer.id, f);
  } else f.update({ opacity: layer.opacity });
}

function sizeTick() {
  if (!st.osn) return;
  for (const [id, i] of st.inputs) {
    try {
      const w = i.width, h = i.height;
      const old = st.sizes.get(id);
      if (w > 0 && h > 0 && (!old || old.width !== w || old.height !== h)) {
        st.sizes.set(id, { width: w, height: h });
        for (const it of st.items.values()) if (it.layer.source === id) applyTransform(it);
      }
    } catch {
      /* source gone */
    }
  }
}

/* ---------------- sound ---------------- */

function onLevels(list) {
  for (const v of Array.isArray(list) ? list : []) {
    const id = fromObsName(v.sourceName);
    if (!id) continue;
    const mag = Array.isArray(v.magnitude) ? Math.max(...v.magnitude.map((x) => (x <= -65535 ? -90 : x))) : -90;
    const peak = Array.isArray(v.peak) ? Math.max(...v.peak.map((x) => (x <= -65535 ? -90 : x))) : -90;
    st.levels.set(id, { mag: Math.max(-90, mag), peak: Math.max(-90, peak) });
  }
}

let lastSound = Date.now();
let lastLevelsSent = 0;
function soundTick() {
  if (!st.osn) return;
  const now = Date.now();
  const dt = now - lastSound;
  lastSound = now;
  for (const it of st.items.values()) {
    const s = it.layer.sound;
    if (!s) continue;
    const db = st.levels.get(s.from)?.mag ?? -90;
    const cur = st.factors.get(it.layer.id) ?? 1;
    st.factors.set(it.layer.id, smoothFactor(cur, levelToFactor(db, s), dt, s));
    applyTransform(it);
  }
  // Mixer meters in Studio: 20 times a second is smooth enough.
  if (now - lastLevelsSent >= 50 && st.levels.size) {
    lastLevelsSent = now;
    emit("levels", Object.fromEntries([...st.levels].map(([id, l]) => [id, l])));
  }
}

/** Mixer settings: { [sourceId]: { volume (0-1.5), muted, monitor: "off"|"only"|"output", syncMs } }. */
function setAudio(map) {
  for (const [id, a] of Object.entries(map ?? {})) {
    const i = st.inputs.get(id);
    if (!i || !a || typeof a !== "object") continue;
    if (typeof a.volume === "number") i.volume = Math.max(0, Math.min(1.5, a.volume));
    if (typeof a.muted === "boolean") i.muted = a.muted;
    if (a.monitor in OBS.monitor) i.monitoringType = OBS.monitor[a.monitor];
    if (typeof a.syncMs === "number") {
      const ms = Math.max(0, Math.min(5000, Math.round(a.syncMs)));
      i.syncOffset = { sec: Math.floor(ms / 1000), nsec: (ms % 1000) * 1_000_000 };
    }
  }
  return { ok: true };
}

/* ---------------- preview ---------------- */

/** The window handle as the Buffer OBS wants (it arrives as a Uint8Array after crossing processes). */
function handleBuffer(h) {
  if (Buffer.isBuffer(h)) return h;
  if (h instanceof Uint8Array) return Buffer.from(h);
  if (h && typeof h === "object") return Buffer.from(Object.values(h).map((n) => Number(n) & 0xff));
  throw new Error("No window to show the preview in");
}

/** The program picture in Studio's preview tile: a native child window over that part of Studio's window. */
function preview({ hwnd, rect, show }) {
  const osn = st.osn;
  if (!show) {
    if (st.display) osn.NodeObs.OBS_content_moveDisplay(st.display, -32000, -32000);
    return { shown: false };
  }
  if (!st.display) {
    st.display = "wl-preview";
    osn.NodeObs.OBS_content_createDisplay(handleBuffer(hwnd), st.display, OBS.renderMain, false, st.ctx);
    osn.NodeObs.OBS_content_setShouldDrawUI(st.display, false);
    osn.NodeObs.OBS_content_setPaddingSize(st.display, 0);
    osn.NodeObs.OBS_content_setPaddingColor(st.display, 5, 7, 15);
  }
  osn.NodeObs.OBS_content_moveDisplay(st.display, Math.round(rect.x), Math.round(rect.y));
  osn.NodeObs.OBS_content_resizeDisplay(st.display, Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
  return { shown: true };
}

/* ---------------- streaming ---------------- */

async function startStream({ url, kbps, audioKbps = 160, prefer, width, height, reconnect = false }) {
  if (st.out && !reconnect) throw new Error("Already live");
  const osn = st.osn;
  const enc = pickEncoder(osn.VideoEncoderFactory.types(), { prefer, failed: st.failedEncoders });
  if (!enc) throw new Error("No video encoder is available on this PC.");
  const canvas = st.plan?.canvas ?? { width: 1920, height: 1080, fps: 60 };
  // The stream's own size (a 1440p canvas can stream 1080p); OBS scales it on the GPU.
  if (width && height && (width !== canvas.width || height !== canvas.height)) setCanvas(canvas, { width, height });
  const link = new RelayLink({ ffmpeg: path.join(st.dir, "ffmpeg.exe"), url, kbps, log });
  const out = { link, info: encoderInfo(enc.id), kbps, url, stopping: false, streaming: null, encoder: null, service: null, audioTrack: null, startedAt: Date.now() };
  st.out = out;
  link.on("relay", (msg) => emit("relay", msg));
  link.on("stats", (s) => (out.linkStats = s));
  link.on("closed", (info) => {
    stopOutput(false, out);
    if (st.out === out) {
      st.out = null;
      // Back to the canvas's own size for the preview (a stream may have been scaled down).
      if (st.plan) setCanvas(st.plan.canvas);
    }
    emit("closed", info);
  });
  link.on("open", () => {
    try {
      out.streaming.start();
      emit("open", { encoder: out.info });
    } catch (e) {
      log("output", "error", e?.message ?? e);
      link.shut(4500, "The engine couldn't start the stream");
    }
  });
  try {
    out.encoder = osn.VideoEncoderFactory.create(enc.id, "wl-video", encoderSettings(enc.id, { kbps }));
    if (out.encoder.lastError) throw new Error(out.encoder.lastError);
    out.audioTrack = osn.AudioTrackFactory.create(Math.max(64, Math.min(320, audioKbps)), "wl-stream");
    osn.AudioTrackFactory.setAtIndex(out.audioTrack, 1);
    const s = osn.AdvancedStreamingFactory.create();
    s.video = st.ctx;
    s.videoEncoder = out.encoder;
    s.audioTrack = 1;
    s.enforceServiceBitrate = false;
    s.enableTwitchVOD = false;
    out.service = osn.ServiceFactory.create("rtmp_custom", "wl-local", { server: "rtmp://127.0.0.1:1/live", key: "x", use_auth: false, bwtest: false });
    s.service = out.service;
    const delay = osn.DelayFactory.create();
    delay.enabled = false;
    s.delay = delay;
    const rc = osn.ReconnectFactory.create();
    rc.enabled = true;
    rc.retryDelay = 1;
    rc.maxRetries = 5;
    s.reconnect = rc;
    const net = osn.NetworkFactory.create();
    net.bindIP = "default";
    // OBS's dynamic bitrate: a congested upload lowers the encoder's bitrate instead of dropping frames.
    net.enableDynamicBitrate = true;
    net.enableOptimizations = false;
    net.enableLowLatency = false;
    s.network = net;
    s.signalHandler = (sig) => onSignal(out, sig);
    out.streaming = s;
    // The local listener first, so OBS has somewhere to publish; then the relay. OBS starts on the relay's "open".
    await link.prepare();
    if (st.out !== out || out.stopping || !out.service) throw new Error("The stream was stopped while starting");
    out.service.update({ server: link.rtmp.server, key: link.rtmp.key, use_auth: false, bwtest: false });
    emit("format", { encoder: out.info, kbps, width: width ?? canvas.width, height: height ?? canvas.height, fps: canvas.fps });
    link.connect();
    return { encoder: out.info };
  } catch (e) {
    link.shut(4500, "The engine couldn't start the stream");
    stopOutput(true, out);
    if (st.out === out) st.out = null;
    throw e;
  }
}

function onSignal(out, sig) {
  emit("output", { signal: sig?.signal, code: sig?.code, error: sig?.error ? String(sig.error).slice(0, 300) : "" });
  if (sig?.signal !== "stop" || out.stopping) return;
  if (sig.code === -8 || sig.code === -65) {
    // The encoder failed (a busy or outdated GPU encoder): the next start uses the next one, like OBS falls back.
    if (!st.failedEncoders.includes(out.info.id)) st.failedEncoders.push(out.info.id);
    log("encoder", "error", `${out.info.id} failed (${sig.code}) ${sig.error ?? ""}`);
    emit("encoder-failed", { encoder: out.info, outdatedDriver: sig.code === -65 });
  }
  // OBS gave up on the local publish: close the relay link so Studio reconnects with a fresh token (as it does for
  // the browser encoder); the relay holds the platforms meanwhile.
  out.link.shut(4500, "Engine output stopped");
}

function stopOutput(force, out = st.out) {
  if (!out) return;
  out.stopping = true;
  try {
    out.streaming?.stop(force);
  } catch {
    /* already stopped */
  }
  const osn = st.osn;
  try {
    if (out.streaming) osn.AdvancedStreamingFactory.destroy(out.streaming);
  } catch {
    /* gone */
  }
  try {
    if (out.service) osn.ServiceFactory.destroy(out.service);
  } catch {
    /* gone */
  }
  try {
    out.encoder?.release();
  } catch {
    /* gone */
  }
  out.streaming = out.service = out.encoder = null;
}

function stopStream() {
  const out = st.out;
  if (!out) return { ok: true };
  out.link.end(); // the relay ends each platform cleanly; "closed" follows and stops the output
  return { ok: true };
}

async function reconnectStream({ url }) {
  const prev = st.out;
  const opts = prev ? { kbps: prev.kbps, prefer: undefined } : { kbps: 6000 };
  if (prev) {
    prev.link.removeAllListeners("closed");
    prev.link.shut(4000, "reconnecting");
    stopOutput(false, prev);
    st.out = null;
  }
  return startStream({ url, kbps: opts.kbps, reconnect: true });
}

/* ---------------- stats ---------------- */

function statsTick() {
  const osn = st.osn, out = st.out;
  if (!osn) return;
  try {
    emit("stats", {
      cpu: Math.round(osn.Global.cpuPercentage * 10) / 10,
      fps: Math.round(osn.Global.currentFrameRate * 10) / 10,
      renderMs: Math.round(osn.Global.averageFrameRenderTime * 100) / 100,
      laggedFrames: osn.Global.laggedFrames,
      skippedFrames: st.ctx?.skippedFrames ?? 0,
      encodedFrames: st.ctx?.encodedFrames ?? 0,
      ...(out?.streaming
        ? {
            live: true,
            encoder: out.info,
            droppedFrames: out.streaming.droppedFrames,
            totalFrames: out.streaming.totalFrames,
            kbps: Math.round(out.streaming.kbitsPerSec),
            targetKbps: out.kbps,
            uploadKbps: out.linkStats?.uploadKbps ?? 0,
            bufferedMs: out.linkStats?.bufferedMs ?? 0,
            congested: !!out.linkStats?.paused,
            secs: Math.round((Date.now() - out.startedAt) / 1000),
          }
        : { live: false }),
    });
  } catch {
    /* engine going down */
  }
}

/* ---------------- messages ---------------- */

const need = (fn) => (args) => {
  if (!st.osn) throw new Error("The engine isn't running");
  return fn(args);
};

const HANDLERS = {
  init,
  shutdown,
  devices: need(devices),
  setScene: need(setScene),
  setAudio: need(setAudio),
  preview: need(preview),
  startStream: need(startStream),
  stopStream: need(stopStream),
  reconnectStream: need(reconnectStream),
};

parent.on("message", async (e) => {
  const { id, type, args } = e.data ?? {};
  const fn = HANDLERS[type];
  if (!fn) return parent.postMessage({ id, ok: false, error: `Unknown engine call ${type}` });
  try {
    const result = await fn(args ?? {});
    parent.postMessage({ id, ok: true, result });
  } catch (err) {
    parent.postMessage({ id, ok: false, error: String(err?.message ?? err).slice(0, 500) });
  }
  if (type === "shutdown") setTimeout(() => process.exit(0), 200);
});

emit("hello", { pid: process.pid });
