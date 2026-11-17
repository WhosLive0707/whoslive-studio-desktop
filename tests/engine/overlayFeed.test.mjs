import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { OverlayFeed, OverlayState, toWire } from "../../src/engine/overlayFeed.js";

test("a late page catches up: latest of each, images, chat, icons, stickers, then planes and the scene", () => {
  const s = new OverlayState();
  const t0 = 1_000_000;
  s.take({ type: "scene", scene: { id: "a" }, fade: true }, t0);
  s.take({ type: "scene", scene: { id: "b" }, fade: true }, t0);
  s.take({ type: "theme", theme: { id: "neon" }, cams: [] }, t0);
  s.take({ type: "image", id: "img1", data: new ArrayBuffer(4), mime: "image/png" }, t0);
  s.take({ type: "image", id: "img2", data: new ArrayBuffer(4), mime: "image/png" }, t0);
  s.take({ type: "removeSource", id: "img2" }, t0);
  for (let i = 0; i < 70; i++) s.take({ type: "chat", channel: "Nate", msg: { text: String(i) } }, t0);
  s.take({ type: "chatEmotes", emotes: { u1: { png: new ArrayBuffer(1) }, u2: { png: new ArrayBuffer(1) } } }, t0);
  s.take({ type: "chatEmotes", emotes: {}, drop: ["u1"] }, t0);
  s.take({ type: "stickers", spot: "corners", arts: [{ png: new ArrayBuffer(1) }] }, t0);
  s.take({ type: "stickers", spot: "falling", arts: [{ png: new ArrayBuffer(1) }] }, t0);
  s.take({ type: "stickers", spot: "falling", arts: [] }, t0);
  s.take({ type: "banner", text: "BRB", seconds: 10 }, t0);
  s.take({ type: "planes", planes: { 0: { layers: ["l1"], top: true } } }, t0);
  assert.equal(s.take({ type: "thumbs", req: 1 }, t0), false);
  assert.equal(s.take({ type: "alert", alert: { kind: "follow" } }, t0), true);

  const r = s.replay(t0 + 4000);
  const types = r.map((m) => m.type);
  assert.deepEqual(types.slice(-2), ["planes", "scene"]);
  assert.equal(r.at(-1).scene.id, "b");
  assert.equal(r.at(-1).fade, false);
  assert.deepEqual(r.filter((m) => m.type === "image").map((m) => m.id), ["img1"]);
  const chat = r.find((m) => m.type === "chatList");
  assert.equal(chat.channel, "nate");
  assert.equal(chat.msgs.length, 60);
  assert.equal(chat.msgs[0].text, "10");
  assert.deepEqual(Object.keys(r.find((m) => m.type === "chatEmotes").emotes), ["u2"]);
  assert.deepEqual(r.filter((m) => m.type === "stickers").map((m) => m.spot), ["corners"]);
  assert.equal(Math.round(r.find((m) => m.type === "banner").seconds), 6);
  assert.ok(!types.includes("alert"));
  assert.equal(s.replay(t0 + 11_000).some((m) => m.type === "banner"), false);
});

test("pictures go to the page as base64", () => {
  const w = toWire({ type: "image", data: new Uint8Array([1, 2, 3]).buffer, nested: [{ png: new Uint8Array([4]) }] });
  assert.deepEqual(w.data, { $b64: "AQID" });
  assert.deepEqual(w.nested[0].png, { $b64: "BA==" });
});

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    ws.on("open", () => resolve({ ws, got }));
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
const until = async (f) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f());
};

test("only a page with the key connects; it gets the picture so far, then what's new", async () => {
  const feed = new OverlayFeed();
  const { port, key } = await feed.start();
  assert.ok(port > 0 && /^[0-9a-f]{32}$/.test(key));
  await assert.rejects(open(`ws://127.0.0.1:${port}/feed?key=wrong`), /403/);
  feed.post({ type: "scene", scene: { id: "s1" }, fade: false });
  feed.post({ type: "image", id: "i", data: new Uint8Array([9]).buffer, mime: "image/png" });
  const { ws, got } = await open(`ws://127.0.0.1:${port}/feed?key=${key}`);
  await until(() => got.length >= 2);
  assert.equal(got[0].type, "image");
  assert.deepEqual(got[0].data, { $b64: "CQ==" });
  assert.equal(got.at(-1).type, "scene");
  feed.post({ type: "alert", alert: { kind: "tip" } });
  feed.post({ type: "thumbs", req: 2 });
  await until(() => got.some((m) => m.type === "alert"));
  assert.ok(!got.some((m) => m.type === "thumbs"));
  ws.close();
  feed.stop();
});

test("the overlay page and Studio's compositor script are served on this PC; nothing else", async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return url.endsWith("/assets/compositor.worker-Ab1.js") ? new Response("self.x=1") : new Response("", { status: 404 });
  };
  const feed = new OverlayFeed({ fetchImpl });
  const { port } = await feed.start("https://beta.whoslive.io");
  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  };
  const page = await get("/overlay.html?worker=/assets/compositor.worker-Ab1.js&key=x&plane=0");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /initCanvas/);
  const js = await get("/assets/compositor.worker-Ab1.js");
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);
  assert.equal(js.body, "self.x=1");
  await get("/assets/compositor.worker-Ab1.js");
  assert.deepEqual(asked, ["https://beta.whoslive.io/assets/compositor.worker-Ab1.js"]);
  assert.equal((await get("/assets/missing.js")).status, 404);
  assert.equal((await get("/etc/passwd")).status, 404);
  assert.equal((await get("/assets/..%2Fx.js")).status, 404);
  assert.equal((await get("/assets/a.css")).status, 404);
  // A page that isn't a Studio site doesn't change where scripts come from.
  await feed.start("http://evil.example");
  await get("/assets/missing.js");
  assert.equal(asked.at(-1), "https://beta.whoslive.io/assets/missing.js");
  feed.stop();
});
