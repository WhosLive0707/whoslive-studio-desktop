// The native engine's video encoder: the best one this PC has, with OBS's own tuned settings.
//
// Order is OBS's: the GPU's hardware encoder first (NVIDIA NVENC, AMD AMF, Intel QuickSync), x264 on the CPU last.
// Every setting not named here is left at OBS's default, which is exactly what OBS streams with (NVENC: preset p5,
// tune hq, two-pass quarter resolution, B-frames, adaptive quantization; AMF: quality preset; QuickSync: TU4).
// Pure: no OBS calls, so it is tested without OBS (tests/engine/encoders.test.mjs).

/** Best first. `codec` is what the relay must be told the stream is. */
export const ENCODERS = [
  { id: "obs_nvenc_h264_tex", vendor: "nvidia", codec: "h264", label: "NVIDIA NVENC H.264" },
  { id: "h264_texture_amf", vendor: "amd", codec: "h264", label: "AMD AMF H.264" },
  { id: "obs_qsv11_v2", vendor: "intel", codec: "h264", label: "Intel QuickSync H.264" },
  { id: "obs_x264", vendor: "cpu", codec: "h264", label: "x264 (CPU)" },
];

const KNOWN = new Map(ENCODERS.map((e) => [e.id, e]));

/**
 * The encoder to stream with. `available`: VideoEncoderFactory.types() on this PC. `prefer`: an id the streamer
 * picked (kept when this PC has it). `failed`: ids that already failed to start this session (never retried).
 * Null when nothing usable is installed (OBS always has x264, so this means OBS itself is broken).
 */
export function pickEncoder(available, { prefer, failed = [] } = {}) {
  const have = new Set(Array.isArray(available) ? available : []);
  const bad = new Set(failed);
  if (prefer && KNOWN.has(prefer) && have.has(prefer) && !bad.has(prefer)) return KNOWN.get(prefer);
  return ENCODERS.find((e) => have.has(e.id) && !bad.has(e.id)) ?? null;
}

/** Whole kbps within what platforms take (Twitch's ceiling is 8,000; YouTube 1440p60 takes up to 24,000). */
export const clampKbps = (kbps) => Math.max(500, Math.min(51_000, Math.round(Number(kbps) || 6000)));

/**
 * Settings for `id` at `kbps`. Constant bitrate and a 2-second keyframe interval: what every platform asks for, and
 * what the relay's per-platform pushers need (they start each platform on a keyframe).
 */
export function encoderSettings(id, { kbps, keyintSec = 2 } = {}) {
  const bitrate = clampKbps(kbps);
  const keyint_sec = Math.max(1, Math.min(4, Math.round(keyintSec)));
  switch (id) {
    case "obs_nvenc_h264_tex":
      return { rate_control: "cbr", bitrate, keyint_sec };
    case "h264_texture_amf":
      return { rate_control: "CBR", bitrate, keyint_sec, preset: "quality", profile: "high" };
    case "obs_qsv11_v2":
      return { rate_control: "CBR", bitrate, keyint_sec, profile: "high" };
    case "obs_x264":
      return { rate_control: "CBR", bitrate, keyint_sec, preset: "veryfast", profile: "high" };
    default:
      return { rate_control: "CBR", bitrate, keyint_sec };
  }
}

/** What to tell Studio about the encoder in use ("hardware" drives the quality badge Studio already shows). */
export function encoderInfo(id) {
  const e = KNOWN.get(id);
  return e ? { id, label: e.label, vendor: e.vendor, codec: e.codec, hardware: e.vendor !== "cpu" } : { id, label: id, vendor: "unknown", codec: "h264", hardware: false };
}
