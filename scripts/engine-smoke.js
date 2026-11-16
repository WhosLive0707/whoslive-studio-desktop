// Smoke test of the real engine on Windows (CI: .github/workflows/native-engine.yml). Runs in Electron like the app:
// starts OBS's engine through the same client Studio's calls go through, builds a scene, shows the preview in a
// window, streams with x264 (CI machines have no GPU encoder) to a stand-in relay on this machine for 8 seconds,
// ends it the way Studio does, and checks with ffprobe that the relay got real H.264 + AAC in Matroska.
// Exit code 0 is a pass. Never points at a real relay or platform.
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { EngineClient, engineAvailable, engineDir } from "../src/engine/client.js";

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  app.exit(1);
};
const step = (msg) => console.log(`smoke: ${msg}`);

app.whenReady().then(async () => {
  try {
    if (!engineAvailable()) return fail(`engine not found in ${engineDir()}`);
    const win = new BrowserWindow({ width: 1280, height: 800, show: true });
    await win.loadURL("about:blank");
    const events = [];
    const client = new EngineClient({ version: "smoke", log: (s, l, m) => console.log(`engine ${l} ${s}: ${m}`) });
    client.setOwner(win.webContents);
    win.webContents.send = (_ch, event, data) => events.push({ event, data });
    const t0 = Date.now();
    await client.init();
    step(`engine started in ${Date.now() - t0} ms`);
    const dev = await client.call("devices");
    step(`devices: ${dev.cameras.length} cameras, ${dev.mics.length} mics, ${dev.monitors.length} monitors; encoders ${dev.encoders.map((e) => e.id).join(", ")}`);
    if (!dev.encoders.some((e) => e.id === "obs_x264")) return fail("x264 missing");
    const sources = [{ id: "bg", kind: "color", color: "#18c2b4" }];
    const layers = [{ id: "L-bg", source: "bg", x: 0, y: 0, w: 1920, h: 1080, fit: "fill" }];
    if (dev.monitors[0]) {
      sources.push({ id: "screen", kind: "display", monitor: dev.monitors[0].id });
      layers.push({ id: "L-screen", source: "screen", x: 960, y: 540, w: 960, h: 540, flipX: true });
    }
    sources.push({ id: "speakers", kind: "speakers" });
    await client.call("setScene", { canvas: { width: 1920, height: 1080, fps: 30 }, sources, layers });
    await client.call("preview", client.previewArgs(win.webContents, { rect: { x: 0, y: 0, width: 960, height: 540 }, show: true }));
    step("scene and preview up");

    const got = { bytes: 0, chunks: [], ended: false, url: "" };
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => wss.on("listening", r));
    wss.on("connection", (ws, req) => {
      got.url = req.url;
      ws.send(JSON.stringify({ type: "ready", sid: "smoke", dests: ["Local"], dry: false }));
      ws.on("message", (d, bin) => {
        if (!bin) {
          if (JSON.parse(String(d)).type === "end") got.ended = true;
          return;
        }
        got.bytes += d.length;
        got.chunks.push(Buffer.from(d));
      });
    });
    const start = await client.call("startStream", { url: `ws://127.0.0.1:${wss.address().port}/ingest?t=smoke`, kbps: 3000, prefer: "obs_x264" });
    step(`streaming with ${start.encoder.label}`);
    await new Promise((r) => setTimeout(r, 8000));
    const stats = events.filter((e) => e.event === "stats").at(-1)?.data;
    step(`stats: ${JSON.stringify(stats)}`);
    await client.call("stopStream");
    for (let i = 0; i < 50 && !events.some((e) => e.event === "closed"); i++) await new Promise((r) => setTimeout(r, 100));
    if (!events.some((e) => e.event === "open")) return fail("stream never opened");
    if (!got.ended) return fail("relay never got the end message");
    if (got.bytes < 500_000) return fail(`relay got only ${got.bytes} bytes`);
    if (!/a=aac$/.test(got.url)) return fail(`relay url ${got.url}`);
    const file = path.join(app.getPath("temp"), "whoslive-smoke.mkv");
    writeFileSync(file, Buffer.concat(got.chunks));
    const probe = JSON.parse(execFileSync(path.join(engineDir(), "ffprobe.exe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
    const v = probe.streams.find((s) => s.codec_type === "video");
    const a = probe.streams.find((s) => s.codec_type === "audio");
    step(`probe: video ${v?.codec_name} ${v?.width}x${v?.height}, audio ${a?.codec_name} ${a?.sample_rate} Hz`);
    if (v?.codec_name !== "h264" || v.width !== 1920 || v.height !== 1080) return fail("video isn't 1080p H.264");
    if (a?.codec_name !== "aac") return fail("audio isn't AAC");
    client.stop();
    wss.close();
    step("PASS");
    setTimeout(() => app.exit(0), 1500);
  } catch (e) {
    fail(e?.stack ?? e);
  }
});
