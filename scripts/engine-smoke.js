// Smoke test of the real engine on Windows (CI: .github/workflows/native-engine.yml). Runs in Electron like the app:
// starts OBS's engine through the same client Studio's calls go through, builds a scene, shows the preview in a
// window, streams with x264 (CI machines have no GPU encoder) to a stand-in relay on this machine for 8 seconds,
// ends it the way Studio does, and checks with ffprobe that the relay got real H.264 + AAC in Matroska. Studio's
// overlays: a see-through overlay page (overlayFeed.js, with a stand-in for Studio's compositor script) is on top, and
// the stream's picture must show it over the scene.
// Exit code 0 is a pass. Never points at a real relay or platform.
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { EngineClient, engineAvailable, engineDir } from "../src/engine/client.js";
import { OverlayFeed } from "../src/engine/overlayFeed.js";

/** A stand-in for Studio's compositor script: once Studio's scene arrives, magenta over the top-left quarter. */
const FAKE_COMPOSITOR = `let c = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "initCanvas") c = m.canvas.getContext("2d");
  else if (m.type === "scene" && c) setInterval(() => {
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.fillStyle = "#ff00ff";
    c.fillRect(0, 0, c.canvas.width / 2, c.canvas.height / 2);
  }, 100);
};`;

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
    // Started the way Studio starts it: an init with no settings from the page.
    await client.call("init", {});
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
    // Studio's overlays: the app's overlay page, its compositor script from "Studio's site" (here, on this PC).
    const site = http.createServer((req, res) => {
      if (req.url === "/assets/compositor.worker-smoke.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(FAKE_COMPOSITOR);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => site.listen(0, "127.0.0.1", r));
    const feed = new OverlayFeed({ log: (s, l, m) => console.log(`overlay ${l} ${s}: ${m}`) });
    const ov = await feed.start(`http://127.0.0.1:${site.address().port}`);
    feed.post({ type: "scene", scene: { id: "smoke", name: "Smoke", layers: [] }, fade: false });
    const ovUrl = `http://127.0.0.1:${ov.port}/overlay.html?worker=/assets/compositor.worker-smoke.js&key=${ov.key}&w=1920&h=1080&fps=30&plane=0`;
    sources.push({ id: "ov", kind: "overlay", url: ovUrl, fps: 30 });
    layers.push({ id: "L-ov", source: "ov", x: 0, y: 0, w: 1920, h: 1080, fit: "fill" });
    await client.call("setScene", { canvas: { width: 1920, height: 1080, fps: 30 }, sources, layers });
    await client.call("preview", client.previewArgs(win.webContents, { rect: { x: 0, y: 0, width: 960, height: 540 }, show: true }));
    step("scene and preview up");
    // The overlay page's browser starts with the scene; give it a moment before the stream starts.
    await new Promise((r) => setTimeout(r, 3000));

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
    // The overlay page is in the picture: magenta top-left (Studio's overlay), the scene's teal top-right through it.
    const px = execFileSync(path.join(engineDir(), "ffmpeg.exe"), ["-v", "error", "-sseof", "-1.5", "-i", file, "-frames:v", "1", "-vf", "scale=192:108", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const at = (x, y) => [...px.subarray((y * 192 + x) * 3, (y * 192 + x) * 3 + 3)];
    const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) < 48);
    step(`overlay pixels: top-left ${at(48, 27)}, top-right ${at(144, 27)}`);
    if (!near(at(48, 27), [255, 0, 255])) return fail("the overlay page isn't in the picture");
    if (!near(at(144, 27), [0x18, 0xc2, 0xb4])) return fail("the overlay page isn't see-through");

    // The vertical picture on the engine's second canvas: the main picture (with its overlay) in the middle box,
    // the main picture blurred and dimmed behind it, streamed to its own relay link.
    await client.call("setVerticalScene", {
      canvas: { width: 1080, height: 1920, fps: 30 },
      sources: [{ id: "wl-program-blur", kind: "program-blur" }, { id: "wl-program", kind: "program" }],
      layers: [
        { id: "V-bg", source: "wl-program-blur", x: 0, y: 0, w: 1080, h: 1920, fit: "cover" },
        { id: "V-main", source: "wl-program", x: 0, y: 656, w: 1080, h: 608, fit: "contain" },
      ],
    });
    // What the engine built for it, and what its canvas draws before any stream (for when the stream's pixels are off).
    await new Promise((r) => setTimeout(r, 2000));
    const built = await client.post("describe", { shots: true });
    step(`vertical built: ${JSON.stringify(built)}`);
    if (typeof built.shots?.vertical === "string" && !built.shots.vertical.startsWith("failed")) {
      const spx = execFileSync(path.join(engineDir(), "ffmpeg.exe"), ["-v", "error", "-i", built.shots.vertical, "-vf", "scale=108:192", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      const sat = (x, y) => [...spx.subarray((y * 108 + x) * 3, (y * 108 + x) * 3 + 3)];
      step(`vertical canvas (screenshot): box top-left ${sat(20, 70)}, box right ${sat(90, 70)}, backdrop ${sat(54, 20)}`);
    }
    const vgot = { bytes: 0, chunks: [], ended: false };
    const vss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => vss.on("listening", r));
    vss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "ready", sid: "smoke-v", dests: ["Local"], dry: false }));
      ws.on("message", (d, bin) => {
        if (!bin) {
          if (JSON.parse(String(d)).type === "end") vgot.ended = true;
          return;
        }
        vgot.bytes += d.length;
        vgot.chunks.push(Buffer.from(d));
      });
    });
    await client.call("startStream", { url: `ws://127.0.0.1:${vss.address().port}/ingest?t=smoke-v`, kbps: 3000, prefer: "obs_x264", canvas: "vertical" });
    await new Promise((r) => setTimeout(r, 6000));
    await client.call("stopStream", { canvas: "vertical" });
    for (let i = 0; i < 50 && !events.some((e) => e.event === "closed" && e.data?.canvas === "vertical"); i++) await new Promise((r) => setTimeout(r, 100));
    if (!vgot.ended || vgot.bytes < 200_000) return fail(`vertical: relay got ${vgot.bytes} bytes, ended ${vgot.ended}`);
    const vfile = path.join(app.getPath("temp"), "whoslive-smoke-vertical.mkv");
    writeFileSync(vfile, Buffer.concat(vgot.chunks));
    const vprobe = JSON.parse(execFileSync(path.join(engineDir(), "ffprobe.exe"), ["-v", "error", "-show_streams", "-of", "json", vfile]).toString());
    const vv = vprobe.streams.find((s) => s.codec_type === "video");
    step(`vertical probe: video ${vv?.codec_name} ${vv?.width}x${vv?.height}`);
    if (vv?.codec_name !== "h264" || vv.width !== 1080 || vv.height !== 1920) return fail("vertical video isn't 1080x1920 H.264");
    const vpx = execFileSync(path.join(engineDir(), "ffmpeg.exe"), ["-v", "error", "-sseof", "-1.5", "-i", vfile, "-frames:v", "1", "-vf", "scale=108:192", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const vat = (x, y) => [...vpx.subarray((y * 108 + x) * 3, (y * 108 + x) * 3 + 3)];
    // In the box (y 656..1264): the overlay's magenta top-left quarter, the scene's teal top-right.
    step(`vertical pixels: box top-left ${vat(20, 70)}, box right ${vat(90, 70)}, backdrop ${vat(54, 20)}`);
    if (!near(vat(20, 70), [255, 0, 255])) return fail("the vertical picture doesn't show the main picture's overlay");
    if (!near(vat(90, 70), [0x18, 0xc2, 0xb4])) return fail("the vertical picture doesn't show the main picture");
    const bg = vat(54, 20);
    if (bg[0] + bg[1] + bg[2] < 60) return fail("the vertical picture's backdrop is empty");
    // Another picture of the main scene at its own frame rate (LinkedIn's 30 next to 60; here 15 next to the main 30):
    // its own canvas with the main layers copied, encoded and streamed on its own link.
    const xgot = { bytes: 0, chunks: [], ended: false };
    const xss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => xss.on("listening", r));
    xss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "ready", sid: "smoke-x", dests: ["Local"], dry: false }));
      ws.on("message", (d, bin) => {
        if (!bin) {
          if (JSON.parse(String(d)).type === "end") xgot.ended = true;
          return;
        }
        xgot.bytes += d.length;
        xgot.chunks.push(Buffer.from(d));
      });
    });
    await client.call("startStream", { url: `ws://127.0.0.1:${xss.address().port}/ingest?t=smoke-x`, kbps: 3000, fps: 15, prefer: "obs_x264", canvas: "r1" });
    await new Promise((r) => setTimeout(r, 6000));
    const xbuilt = await client.post("describe", {});
    step(`extra picture: ${JSON.stringify(Object.fromEntries(Object.entries(xbuilt.extras ?? {}).map(([k, x]) => [k, { fps: x.fps, items: x.items.length }])))}`);
    await client.call("stopStream", { canvas: "r1" });
    for (let i = 0; i < 50 && !events.some((e) => e.event === "closed" && e.data?.canvas === "r1"); i++) await new Promise((r) => setTimeout(r, 100));
    if (!xgot.ended || xgot.bytes < 200_000) return fail(`extra picture: relay got ${xgot.bytes} bytes, ended ${xgot.ended}`);
    const xfile = path.join(app.getPath("temp"), "whoslive-smoke-extra.mkv");
    writeFileSync(xfile, Buffer.concat(xgot.chunks));
    const xprobe = JSON.parse(execFileSync(path.join(engineDir(), "ffprobe.exe"), ["-v", "error", "-show_streams", "-of", "json", xfile]).toString());
    const xv = xprobe.streams.find((s) => s.codec_type === "video");
    step(`extra probe: video ${xv?.codec_name} ${xv?.width}x${xv?.height} ${xv?.avg_frame_rate}`);
    if (xv?.codec_name !== "h264" || xv.width !== 1920 || xv.height !== 1080) return fail("the extra picture isn't 1080p H.264");
    const [fn, fd] = String(xv.avg_frame_rate ?? "0/1").split("/").map(Number);
    if (!(fd > 0) || Math.abs(fn / fd - 15) > 2) return fail(`the extra picture runs at ${xv.avg_frame_rate}, not 15 fps`);
    const xpx = execFileSync(path.join(engineDir(), "ffmpeg.exe"), ["-v", "error", "-sseof", "-1.5", "-i", xfile, "-frames:v", "1", "-vf", "scale=192:108", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const xat = (x, y) => [...xpx.subarray((y * 192 + x) * 3, (y * 192 + x) * 3 + 3)];
    step(`extra pixels: top-left ${xat(48, 27)}, top-right ${xat(144, 27)}`);
    if (!near(xat(48, 27), [255, 0, 255])) return fail("the extra picture doesn't show the overlay");
    if (!near(xat(144, 27), [0x18, 0xc2, 0xb4])) return fail("the extra picture doesn't show the scene");
    xss.close();
    await client.call("setVerticalScene", { off: true });
    vss.close();
    feed.stop();
    site.close();
    client.stop();
    wss.close();
    step("PASS");
    setTimeout(() => app.exit(0), 1500);
  } catch (e) {
    fail(e?.stack ?? e);
  }
});
