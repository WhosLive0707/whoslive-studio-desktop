import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSettings, toInput } from "../../src/engine/sources.js";

test("screen, window and game capture use OBS's capture sources (Windows Graphics Capture, game hook)", () => {
  const d = toInput({ id: "s1", kind: "display", monitor: "\\\\?\\DISPLAY#GSM5B7F" });
  assert.equal(d.obsId, "monitor_capture");
  assert.equal(d.settings.method, 2);
  const w = toInput({ id: "s2", kind: "window", window: "Game:UnityWndClass:game.exe" });
  assert.equal(w.obsId, "window_capture");
  assert.equal(w.settings.window, "Game:UnityWndClass:game.exe");
  const g = toInput({ id: "s3", kind: "game" });
  assert.equal(g.obsId, "game_capture");
  assert.equal(g.settings.capture_mode, "any_fullscreen");
  assert.equal(g.settings.anti_cheat_hook, true);
  assert.equal(toInput({ id: "s4", kind: "game", window: "X:Y:z.exe" }).settings.capture_mode, "window");
});

test("cameras and capture cards are DirectShow inputs; their own mic stays muted unless asked", () => {
  const c = toInput({ id: "cam", kind: "camera", device: "Elgato HD60 X:\\\\?\\usb#vid", resolution: "1920x1080", fps: 60 });
  assert.equal(c.obsId, "dshow_input");
  assert.equal(c.settings.res_type, 1);
  assert.equal(c.settings.frame_interval, 166667);
  assert.equal(c.audio, false);
  assert.equal(toInput({ id: "cam", kind: "camera", device: "x", audio: true }).audio, true);
  assert.equal(toInput({ id: "cam", kind: "camera", device: "x" }).settings.res_type, 0);
});

test("mics, line-ins, desktop audio and per-app audio are WASAPI sources", () => {
  assert.equal(toInput({ id: "m", kind: "mic", device: "{0.0.1.00000000}.{abc}" }).obsId, "wasapi_input_capture");
  assert.equal(toInput({ id: "m", kind: "mic" }).settings.device_id, "default");
  assert.equal(toInput({ id: "d", kind: "speakers" }).obsId, "wasapi_output_capture");
  assert.equal(toInput({ id: "a", kind: "app-audio", window: "Spotify:Chrome_WidgetWin_0:Spotify.exe" }).obsId, "wasapi_process_output_capture");
  assert.equal(toInput({ id: "a", kind: "app-audio" }), null);
});

test("overlays fill the canvas with a transparent page; only https (or this PC) pages load", () => {
  const o = toInput({ id: "ov", kind: "overlay", url: "https://beta.whoslive.io/studio/overlay?k=abc" }, { width: 2560, height: 1440 });
  assert.equal(o.obsId, "browser_source");
  assert.equal(o.settings.width, 2560);
  assert.match(o.settings.css, /rgba\(0, 0, 0, 0\)/);
  assert.equal(toInput({ id: "ov", kind: "overlay", url: "javascript:alert(1)" }), null);
  assert.equal(toInput({ id: "b", kind: "browser", url: "http://evil.example/" }), null);
  assert.ok(toInput({ id: "b", kind: "browser", url: "http://127.0.0.1:4455/alerts" }));
});

test("files must be real Windows paths; bad ids and unknown kinds are refused", () => {
  assert.ok(toInput({ id: "i", kind: "image", file: "C:\\Users\\me\\logo.png" }));
  assert.equal(toInput({ id: "i", kind: "image", file: "../../etc/passwd" }), null);
  assert.equal(toInput({ id: "bad id", kind: "mic" }), null);
  assert.equal(toInput({ id: "x", kind: "vlc_source" }), null);
});

test("colors become OBS's ABGR", () => {
  assert.equal(toInput({ id: "c", kind: "color", color: "#ff0000" }).settings.color, 0xff0000ff);
});

test("only changed settings are sent", () => {
  assert.equal(changedSettings({ a: 1, b: "x" }, { a: 1, b: "x" }), null);
  assert.deepEqual(changedSettings({ a: 1, b: "x" }, { a: 2, b: "x" }), { a: 2 });
});
