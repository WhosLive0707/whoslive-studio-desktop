// Studio's sources as OBS inputs: which OBS source type, with which settings. Pure (tested without OBS).
//
// Studio sends sources in the engine's own small format (docs/native-engine.md, "Scene"), never OBS settings
// directly: everything that reaches OBS is built here from checked fields, so a page can't load arbitrary plugins,
// files or URLs into the engine.

const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v, d = false) => (typeof v === "boolean" ? v : d);
const int = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const httpUrl = (u) => /^https:\/\/[^\s]+$/i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(u);
const winPath = (p) => /^[A-Za-z]:\\[^<>"|?*]+$/.test(p) || /^\\\\[^<>"|?*]+$/.test(p);

/** OBS's capture methods: Windows Graphics Capture is what OBS picks for windows and monitors on Windows 10 2004+. */
export const METHOD = { auto: 0, dxgi: 1, wgc: 2 };

/** Every kind Studio may send, and what OBS source each becomes. */
export const KINDS = {
  display: "monitor_capture",
  window: "window_capture",
  game: "game_capture",
  camera: "dshow_input",
  mic: "wasapi_input_capture",
  speakers: "wasapi_output_capture",
  "app-audio": "wasapi_process_output_capture",
  image: "image_source",
  media: "ffmpeg_source",
  browser: "browser_source",
  overlay: "browser_source",
  color: "color_source_v3",
};

/** Kinds that only make sound (no scene item). */
export const AUDIO_ONLY = new Set(["mic", "speakers", "app-audio"]);

/**
 * One Studio source as an OBS input: { id, obsId, settings }. Null when the source isn't valid (never a guess).
 * `canvas`: the program's base size (overlays fill it).
 */
export function toInput(src, canvas = { width: 1920, height: 1080 }) {
  if (!src || typeof src !== "object") return null;
  const id = str(src.id, 64);
  if (!ID.test(id)) return null;
  const kind = str(src.kind, 20);
  const obsId = KINDS[kind];
  if (!obsId) return null;
  const s = (settings) => ({ id, kind, obsId, settings, ...(kind === "camera" ? { audio: bool(src.audio, false) } : {}) });
  switch (kind) {
    case "display": {
      const monitor = str(src.monitor);
      if (!monitor) return null;
      return s({ monitor_id: monitor, method: METHOD.wgc, capture_cursor: bool(src.cursor, true), force_sdr: false });
    }
    case "window": {
      const window = str(src.window);
      if (!window) return null;
      return s({ window, method: METHOD.wgc, cursor: bool(src.cursor, true), client_area: true, priority: 2 });
    }
    case "game": {
      const window = str(src.window);
      return s({
        capture_mode: window ? "window" : "any_fullscreen",
        ...(window ? { window, priority: 2 } : {}),
        capture_cursor: bool(src.cursor, false),
        allow_transparency: false,
        // OBS's compatibility hook for games with anti-cheat: what OBS users get by default.
        anti_cheat_hook: true,
        capture_overlays: false,
        limit_framerate: false,
      });
    }
    case "camera": {
      const device = str(src.device);
      if (!device) return null;
      const res = /^\d{3,4}x\d{3,4}$/.test(str(src.resolution, 12)) ? str(src.resolution, 12) : "";
      const fps = int(src.fps, 0, 240, 0);
      return s({
        video_device_id: device,
        // Custom resolution only when Studio asked for one; otherwise the device's own preferred format (OBS default).
        res_type: res ? 1 : 0,
        ...(res ? { resolution: res } : {}),
        ...(res && fps ? { frame_interval: Math.round(10_000_000 / fps) } : {}),
        // A capture card's sound is captured into the source itself (OBS's "Capture audio only"); a webcam's mic is
        // muted by the engine unless Studio asked for it (src.audio), so a webcam never adds a second voice.
        audio_output_mode: 0,
        deactivate_when_not_showing: false,
        active: true,
      });
    }
    case "mic":
    case "speakers": {
      const device = str(src.device) || "default";
      return s({ device_id: device, use_device_timing: kind === "speakers" });
    }
    case "app-audio": {
      const window = str(src.window);
      if (!window) return null;
      return s({ window, priority: 2 });
    }
    case "image": {
      const file = str(src.file, 1024);
      if (!winPath(file)) return null;
      return s({ file, unload: false });
    }
    case "media": {
      const file = str(src.file, 1024);
      if (!winPath(file)) return null;
      return s({ is_local_file: true, local_file: file, looping: bool(src.loop, true), restart_on_activate: false, hw_decode: true, close_when_inactive: false });
    }
    case "browser":
    case "overlay": {
      const url = str(src.url, 2048);
      if (!httpUrl(url)) return null;
      const full = kind === "overlay";
      return s({
        url,
        width: full ? canvas.width : int(src.width, 16, 7680, 1920),
        height: full ? canvas.height : int(src.height, 16, 4320, 1080),
        fps_custom: true,
        fps: int(src.fps, 1, 60, full ? 60 : 30),
        // Transparent page background, like a StreamElements overlay in OBS.
        css: full ? "body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }" : str(src.css, 4000),
        shutdown: false,
        restart_when_active: false,
        reroute_audio: true,
        webpage_control_level: 1,
      });
    }
    case "color": {
      const hex = /^#[0-9a-f]{6}$/i.test(str(src.color, 7)) ? str(src.color, 7) : "#000000";
      // OBS colors are 0xAABBGGRR.
      const n = parseInt(hex.slice(1), 16);
      const abgr = (0xff << 24) | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
      return s({ color: abgr >>> 0, width: canvas.width, height: canvas.height });
    }
    default:
      return null;
  }
}

/** Same OBS input, new settings only (no recreate needed): the kind and the OBS type are unchanged. */
export const sameType = (a, b) => !!a && !!b && a.obsId === b.obsId && a.kind === b.kind;

/** Settings that differ (shallow). Recreating an input restarts it (a camera blinks), so only changes are sent. */
export function changedSettings(prev, next) {
  const out = {};
  let any = false;
  for (const [k, v] of Object.entries(next ?? {})) {
    if (JSON.stringify(prev?.[k]) !== JSON.stringify(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}
