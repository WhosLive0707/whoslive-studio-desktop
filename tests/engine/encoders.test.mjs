import { test } from "node:test";
import assert from "node:assert/strict";
import { encoderInfo, encoderSettings, pickEncoder } from "../../src/engine/encoders.js";

const ALL = ["obs_x264", "obs_qsv11_v2", "h264_texture_amf", "obs_nvenc_h264_tex", "obs_nvenc_hevc_tex", "ffmpeg_svt_av1"];

test("the GPU's encoder beats x264, NVIDIA first like OBS", () => {
  assert.equal(pickEncoder(ALL).id, "obs_nvenc_h264_tex");
  assert.equal(pickEncoder(["obs_x264", "h264_texture_amf"]).id, "h264_texture_amf");
  assert.equal(pickEncoder(["obs_x264", "obs_qsv11_v2"]).id, "obs_qsv11_v2");
  assert.equal(pickEncoder(["obs_x264"]).id, "obs_x264");
  assert.equal(pickEncoder([]), null);
});

test("a streamer's pick is kept when the PC has it, and a failed encoder is never retried", () => {
  assert.equal(pickEncoder(ALL, { prefer: "obs_x264" }).id, "obs_x264");
  assert.equal(pickEncoder(["obs_x264"], { prefer: "obs_nvenc_h264_tex" }).id, "obs_x264");
  assert.equal(pickEncoder(ALL, { failed: ["obs_nvenc_h264_tex"] }).id, "h264_texture_amf");
  assert.equal(pickEncoder(ALL, { prefer: "obs_nvenc_h264_tex", failed: ["obs_nvenc_h264_tex"] }).id, "h264_texture_amf");
});

test("constant bitrate and 2 s keyframes; everything else stays OBS's default", () => {
  assert.deepEqual(encoderSettings("obs_nvenc_h264_tex", { kbps: 8000 }), { rate_control: "cbr", bitrate: 8000, keyint_sec: 2 });
  assert.equal(encoderSettings("obs_x264", { kbps: 6000 }).preset, "veryfast");
  assert.equal(encoderSettings("h264_texture_amf", { kbps: 6000 }).preset, "quality");
  assert.equal(encoderSettings("obs_qsv11_v2", { kbps: 6000 }).rate_control, "CBR");
  assert.equal(encoderSettings("obs_x264", { kbps: 99_999 }).bitrate, 51_000);
  assert.equal(encoderSettings("obs_x264", { kbps: 10 }).bitrate, 500);
  assert.equal(encoderSettings("obs_x264", { kbps: 6000, keyintSec: 9 }).keyint_sec, 4);
});

test("encoder info says whether it is hardware", () => {
  assert.equal(encoderInfo("obs_nvenc_h264_tex").hardware, true);
  assert.equal(encoderInfo("obs_x264").hardware, false);
  assert.equal(encoderInfo("mystery").vendor, "unknown");
});
