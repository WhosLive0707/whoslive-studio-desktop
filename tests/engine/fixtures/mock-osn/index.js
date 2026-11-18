// A stand-in for obs-studio-node with the same shapes the engine uses, recording what was done to it.
// Lets the engine's flow be tested on any OS; the real thing is exercised by the Windows smoke test in CI.
const fs = require("node:fs");
const log = [];
const file = process.env.MOCK_OSN_LOG;
const _push = log.push.bind(log);
log.push = (e) => {
  if (file) fs.appendFileSync(file, JSON.stringify(e) + "\n");
  return _push(e);
};
let nextItem = 1;
let volCb = null;

class Input {
  constructor(id, name, settings) {
    this.id = id;
    this.name = name;
    this.settings = { ...settings };
    this.outputFlags = /wasapi|dshow|browser|ffmpeg/.test(id) ? 3 : 1;
    this.width = id === "dshow_input" ? 1280 : 1920;
    this.height = id === "dshow_input" ? 720 : 1080;
    this.volume = 1;
    this.muted = false;
    this.monitoringType = 0;
    this.syncOffset = { sec: 0, nsec: 0 };
    this.filters = [];
    this.released = false;
    this.properties = { get: (p) => ({ details: { items: [{ name: `${id} first`, value: `${id}:${p}:1` }, { name: "none", value: "" }] } }) };
    log.push(["input", id, name]);
  }
  update(s) {
    Object.assign(this.settings, s);
    log.push(["update", this.name, s]);
  }
  release() {
    this.released = true;
    log.push(["release", this.name]);
  }
  addFilter(f) {
    this.filters.push(f);
  }
  removeFilter(f) {
    this.filters = this.filters.filter((x) => x !== f);
  }
}

class Item {
  constructor(input, scene) {
    this.id = nextItem++;
    this.source = input;
    this.scene = scene;
    this.deferred = 0;
  }
  deferUpdateBegin() {
    this.deferred++;
  }
  deferUpdateEnd() {
    this.deferred--;
    const { position, bounds, alignment, boundsType, scale, crop, visible, cropToBounds } = this;
    log.push(["transform", this.source.name, { position, bounds, alignment, boundsType, scale, crop, visible, cropToBounds }]);
  }
  remove() {
    this.scene.items = this.scene.items.filter((i) => i !== this);
    log.push(["remove-item", this.source.name, this.scene.name]);
  }
  move(n) {
    const a = this.scene.items.filter((i) => i !== this);
    a.splice(n, 0, this);
    this.scene.items = a;
  }
}

class Scene {
  constructor(name, priv = false) {
    this.name = name;
    this.items = [];
    this.private = priv;
    // A scene as a source (nested in another scene): drawn at the size of the canvas it's on.
    this.source = { id: "scene", name, width: 1080, height: 1920, outputFlags: 0, filters: [], addFilter(f) { this.filters.push(f); }, removeFilter() {}, release() {} };
    log.push(["scene", name, priv]);
  }
  add(input) {
    const it = new Item(input, this);
    this.items.push(it);
    log.push(["add-item", input.name, this.name]);
    return it;
  }
  getItems() {
    return this.items;
  }
  release() {}
}

class Streaming {
  constructor() {
    this.droppedFrames = 0;
    this.totalFrames = 600;
    this.kbitsPerSec = 6000;
  }
  start() {
    this.started = true;
    log.push(["stream-start", this.service.settings.server, this.videoEncoder.id, this.videoEncoder.settings]);
    setTimeout(() => this.signalHandler?.({ type: "streaming", signal: "start", code: 0 }), 5);
    // MOCK_NVENC_FAIL: the GPU encoder fails right after starting (a busy or outdated NVENC), like OBS reports it.
    if (process.env.MOCK_NVENC_FAIL && this.videoEncoder.id === "obs_nvenc_h264_tex")
      setTimeout(() => this.signalHandler?.({ type: "streaming", signal: "stop", code: -8, error: "NVENC session limit" }), 40);
  }
  stop() {
    this.started = false;
    log.push(["stream-stop"]);
  }
}

module.exports = {
  __log: log,
  IPC: { host() {}, disconnect() {} },
  NodeObs: {
    SetWorkingDirectory() {},
    OBS_API_initAPI: () => 0,
    RegisterVolmeterCallback(cb) {
      volCb = cb;
      setInterval(() => volCb?.([{ sourceName: "wl-mic", magnitude: [-50, -52], peak: [-40, -41], inputPeak: [-40, -41] }]), 20).unref();
    },
    RemoveVolmeterCallback() {},
    InitShutdownSequence() {},
    OBS_settings_getVideoDevices: () => [{ id: "Cam Link 4K:\\\\?\\usb#1", description: "Cam Link 4K" }],
    OBS_settings_getInputAudioDevices: () => [{ id: "default", description: "Default" }, { id: "{0.0.1}.{mic}", description: "Shure MV7" }],
    OBS_settings_getOutputAudioDevices: () => [{ id: "default", description: "Default" }],
    OBS_content_createDisplay: (...a) => log.push(["display", a[1]]),
    OBS_content_setShouldDrawUI() {},
    OBS_content_setPaddingSize() {},
    OBS_content_setPaddingColor() {},
    OBS_content_moveDisplay: (n, x, y) => log.push(["move", n, x, y]),
    OBS_content_resizeDisplay: (n, w, h) => log.push(["resize", n, w, h]),
    OBS_content_destroyDisplay() {},
  },
  VideoFactory: {
    create: () => {
      let v = null;
      return {
        get video() { return v; },
        set video(x) { v = x; log.push(["video-set", x?.baseWidth, x?.baseHeight, x?.fpsNum]); },
        skippedFrames: 0,
        encodedFrames: 0,
        destroy() { log.push(["video-destroy"]); },
      };
    },
  },
  SceneFactory: { create: (n) => new Scene(n), createPrivate: (n) => new Scene(n, true) },
  TransitionFactory: { create: () => ({ set() {}, release() {} }) },
  Global: { setOutputSource() {}, cpuPercentage: 3.2, currentFrameRate: 60, averageFrameRenderTime: 1.1, laggedFrames: 0 },
  InputFactory: { create: (id, name, s) => new Input(id, name, s) },
  VolmeterFactory: { create: () => ({ attach() {}, destroy() {} }) },
  FilterFactory: { create: (id, name, s) => ({ id, name, settings: { ...s }, update(x) { Object.assign(this.settings, x); log.push(["filter", name, { ...this.settings }]); }, release() {} }) },
  VideoEncoderFactory: {
    types: () => ["obs_x264", "obs_nvenc_h264_tex"],
    create: (id, name, settings) => ({ id, name, settings, lastError: "", release() {} }),
  },
  AudioTrackFactory: { create: (b, n) => ({ bitrate: b, name: n }), setAtIndex() {} },
  AdvancedStreamingFactory: { create: () => new Streaming(), destroy() {} },
  ServiceFactory: { create: (id, n, s) => ({ id, settings: { ...s }, update(x) { Object.assign(this.settings, x); } }), destroy() {} },
  DelayFactory: { create: () => ({}) },
  ReconnectFactory: { create: () => ({}) },
  NetworkFactory: { create: () => ({}) },
};
