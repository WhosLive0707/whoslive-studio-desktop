// The engine host's whole flow, outside Electron and Windows: the bundled dist/engine-host.cjs (npm run build)
// against a stand-in obs-studio-node and ffmpeg, streaming to a local stand-in relay. Proves Studio's calls drive
// OBS the right way and the stream reaches the relay; the real OBS is exercised by the Windows smoke test in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = path.resolve(here, "../../dist/engine-host.cjs");
const mock = path.join(here, "fixtures", "mock-osn");

function startHost(env = {}) {
  const logFile = path.join(mkdtempSync(path.join(tmpdir(), "wl-engine-")), "osn.log");
  const child = fork(path.join(here, "fixtures", "run-host.cjs"), [host], { env: { ...process.env, ...env, MOCK_OSN_LOG: logFile }, stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced" });
  const events = [];
  const waiting = new Map();
  let seq = 0;
  child.on("message", (m) => {
    if (typeof m?.id === "number") {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w?.resolve(m.result);
      else w?.reject(new Error(m.error));
    } else if (m?.event) events.push(m);
  });
  const call = (type, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      child.send({ id, type, args });
    });
  const osnLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const until = async (pred, ms = 5000, what = "") => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out ${what || pred.toString().slice(0, 120)}`);
  };
  return { child, events, call, osnLog, until };
}

function startRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const got = { urls: [], bytes: 0, ended: false, firstBytes: null };
    wss.on("connection", (ws, req) => {
      got.urls.push(req.url);
      ws.send(JSON.stringify({ type: "ready", sid: "s1", dests: ["Twitch", "YouTube"], dry: false }));
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          if (JSON.parse(String(data)).type === "end") {
            got.ended = true;
            ws.send(JSON.stringify({ type: "ended", code: 1000, reason: "streamer ended" }));
          }
          return;
        }
        got.firstBytes ??= Buffer.from(data).subarray(0, 4);
        got.bytes += data.length;
      });
    });
    wss.on("listening", () => resolve({ wss, got, port: wss.address().port }));
  });
}

const scene = (camX = 1500) => ({
  canvas: { width: 1920, height: 1080, fps: 60 },
  sources: [
    { id: "game", kind: "game" },
    { id: "cam", kind: "camera", device: "Cam Link 4K:\\\\?\\usb#1" },
    { id: "mic", kind: "mic", device: "{0.0.1}.{mic}" },
    { id: "console", kind: "mic", device: "{0.0.1}.{line}" },
  ],
  layers: [
    { id: "L-game", source: "game", x: 0, y: 0, w: 1920, h: 1080 },
    { id: "L-cam", source: "cam", x: camX, y: 700, w: 400, h: 360, fit: "contain", flipX: true },
    { id: "L-avatar", source: "cam", x: 100, y: 600, w: 300, h: 400, sound: { on: true, from: "mic", quiet: -64, loud: -49, minScale: 79, maxScale: 100, scaleWidth: false, scaleHeight: true, alignX: "center", alignY: "bottom", attack: 0, release: 0 } },
  ],
});

// The stand-in ffmpeg is a Node script, which Windows can't start as an .exe: on Windows CI the real engine runs instead
// (scripts/engine-smoke.js).
const skip = process.platform === "win32";

test("Studio drives OBS: scene, devices, mixer, preview, then a stream that reaches the relay and ends cleanly", { skip }, async (t) => {
  const h = startHost();
  t.after(() => h.child.kill());
  await h.until(() => h.events.find((e) => e.event === "hello"));
  const init = await h.call("init", { dir: mock, appData: tmpdir(), version: "test" });
  assert.equal(init.ready, true);

  const dev = await h.call("devices", {});
  assert.deepEqual(dev.cameras, [{ id: "Cam Link 4K:\\\\?\\usb#1", name: "Cam Link 4K" }]);
  assert.equal(dev.mics[1].name, "Shure MV7");
  assert.equal(dev.monitors[0].id, "monitor_capture:monitor_id:1");
  assert.ok(dev.encoders.some((e) => e.id === "obs_nvenc_h264_tex" && e.hardware));

  assert.deepEqual(await h.call("setScene", scene()), { changed: true });
  let log = h.osnLog();
  const made = (l) => l.filter((e) => e[0] === "input" && !e[2].startsWith("wl-enum-"));
  assert.deepEqual(made(log).map((e) => e[1]), ["game_capture", "dshow_input", "wasapi_input_capture", "wasapi_input_capture"]);
  assert.ok(log.filter((e) => e[0] === "release" && e[1].startsWith("wl-enum-")).length >= 4); // device listing cleans up
  // Moving the camera only moves it: no source is created again.
  assert.deepEqual(await h.call("setScene", scene(1400)), { changed: true });
  log = h.osnLog();
  assert.equal(made(log).length, 4);
  const camMoves = log.filter((e) => e[0] === "transform" && e[1] === "wl-cam" && e[2].scale.x === -1);
  assert.equal(camMoves.at(-1)[2].position.x, 1400);
  assert.deepEqual(await h.call("setScene", scene(1400)), { changed: false });

  // Scale to sound runs natively from the mic's level (-50 dB here): between 79% and 100% of the height, bottom fixed.
  // The avatar box is 300x400 and the camera 1280x720, so the fitted picture is 300 wide and 168.75 high.
  const fitted = 300 * (720 / 1280);
  const sound = (await h.until(() => h.osnLog().filter((e) => e[0] === "transform" && e[1] === "wl-cam" && e[2].alignment === 8 && e[2].bounds.y < fitted - 0.5).at(-1)))[2];
  const expected = fitted * (0.79 + 0.21 * ((-50 + 64) / 15)); // -50 dB between -64 and -49
  assert.ok(Math.abs(sound.bounds.y - expected) < 0.5, `height ${sound.bounds.y}, expected ${expected}`);
  assert.equal(sound.bounds.x, 300); // width untouched (height only)
  assert.equal(sound.position.y, 600 + 400 / 2 + fitted / 2); // the fitted picture's bottom edge
  await h.until(() => h.events.find((e) => e.event === "levels" && e.data.mic));

  // Swapping the game for a screen recreates only that source; removing the camera removes it and its layers.
  const swapped = scene(1400);
  swapped.sources[0] = { id: "game", kind: "display", monitor: "\\\\?\\DISPLAY1" };
  await h.call("setScene", swapped);
  swapped.sources = swapped.sources.filter((x) => x.id !== "cam");
  swapped.layers = swapped.layers.filter((x) => x.source !== "cam");
  await h.call("setScene", swapped);
  log = h.osnLog();
  assert.ok(log.some((e) => e[0] === "release" && e[1] === "wl-game"));
  assert.ok(log.some((e) => e[0] === "input" && e[1] === "monitor_capture" && e[2] === "wl-game"));
  assert.ok(log.some((e) => e[0] === "release" && e[1] === "wl-cam"));
  assert.ok(log.filter((e) => e[0] === "remove-item" && e[1] === "wl-cam").length >= 2);
  assert.equal(made(log).filter((e) => e[1] === "dshow_input").length, 1); // the camera was never recreated

  assert.deepEqual(await h.call("setAudio", { mic: { volume: 0.8, monitor: "off", syncMs: 120 } }), { ok: true });
  assert.deepEqual(await h.call("preview", { show: true, hwnd: new Uint8Array(8), rect: { x: 10, y: 20, width: 960, height: 540 } }), { shown: true });
  assert.ok(h.osnLog().some((e) => e[0] === "resize" && e[2] === 960 && e[3] === 540));

  const relay = await startRelay();
  t.after(() => relay.wss.close());
  const started = await h.call("startStream", { url: `ws://127.0.0.1:${relay.port}/ingest?t=tok`, kbps: 6000 });
  assert.equal(started.encoder.id, "obs_nvenc_h264_tex");
  await h.until(() => h.events.find((e) => e.event === "open"));
  const out = h.osnLog().find((e) => e[0] === "stream-start");
  assert.match(out[1], /^rtmp:\/\/127\.0\.0\.1:\d+\/live$/);
  assert.deepEqual(out[3], { rate_control: "cbr", bitrate: 6000, keyint_sec: 2 });
  assert.match(relay.got.urls[0], /t=tok&a=aac$/);
  await h.until(() => relay.got.bytes > 8000);
  assert.deepEqual([...relay.got.firstBytes], [0x1a, 0x45, 0xdf, 0xa3]); // the stream starts with its Matroska header
  assert.ok(h.events.some((e) => e.event === "relay" && e.data.type === "ready"));

  await h.call("stopStream", {});
  const closed = await h.until(() => h.events.find((e) => e.event === "closed"), 6000);
  assert.equal(relay.got.ended, true);
  assert.equal(closed.data.code, 1000);
  assert.ok(h.osnLog().some((e) => e[0] === "stream-stop"));
});

test("a failed GPU encoder: the link closes for a reconnect, and the reconnect uses the next encoder", { skip }, async (t) => {
  const h = startHost({ MOCK_NVENC_FAIL: "1" });
  t.after(() => h.child.kill());
  await h.until(() => h.events.find((e) => e.event === "hello"));
  await h.call("init", { dir: mock, appData: tmpdir(), version: "test" });
  await h.call("setScene", scene());
  const relay = await startRelay();
  t.after(() => relay.wss.close());
  const first = await h.call("startStream", { url: `ws://127.0.0.1:${relay.port}/ingest?t=a`, kbps: 6000 });
  assert.equal(first.encoder.id, "obs_nvenc_h264_tex");
  const failed = await h.until(() => h.events.find((e) => e.event === "encoder-failed"));
  assert.equal(failed.data.encoder.id, "obs_nvenc_h264_tex");
  const closed = await h.until(() => h.events.find((e) => e.event === "closed"));
  assert.equal(closed.data.code, 4500); // Studio mints a fresh token and calls reconnect, as it does today
  const again = await h.call("reconnectStream", { url: `ws://127.0.0.1:${relay.port}/ingest?t=b` });
  assert.equal(again.encoder.id, "obs_x264");
  await h.until(() => relay.got.urls.length === 2 && relay.got.bytes > 0);
  assert.match(relay.got.urls[1], /t=b&a=aac$/);
  await h.call("stopStream", {});
  await h.until(() => h.events.filter((e) => e.event === "closed").length === 2, 6000);
});
