// Studio's overlays on the engine's stream (docs/native-engine.md, "Overlays").
//
// The engine draws game, screen, camera and browser-source layers itself. Everything else Studio draws (chat, text,
// alerts, images, widgets, theme, the agent) is drawn by Studio's own compositor in a see-through page that the engine
// shows as a browser source, the way OBS shows a StreamElements overlay. This serves that page on this PC only
// (http://127.0.0.1): the page itself (overlayPage.js), Studio's compositor script passed on from Studio's site, and
// what to draw over a WebSocket. Studio sends its compositor's messages to the app (engine:overlay); a page that
// connects late (or reloads) first gets everything it needs to draw the picture as it is.
import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";
import { OVERLAY_HTML } from "./overlayPage.js";

/** Messages a page needs to catch up on, kept as the latest one of each. */
const LATEST = new Set(["scene", "vscene", "theme", "live", "watermark", "agent", "vtuber", "overlayData", "standDown", "soundLevels", "planes", "vplanes", "config"]);
/** The 3D avatar's and effects' messages that only matter as they happen. */
const AUX_PASS = new Set(["pose", "expression", "event", "stream"]);
/** Messages that only matter as they happen. */
const PASS = new Set(["alert", "agentLevel", "avatarPose"]);
const MAX_CHAT = 60;
const MAX_CLIENTS = 8;
const MAX_MESSAGE = 32 * 1024 * 1024;
/** Studio's built scripts (its compositor and what it imports), passed on from Studio's site. */
export const SCRIPT_PATH = /^\/assets\/[\w.-]+\.js$/;
const MAX_SCRIPTS = 64;

/** ArrayBuffers (pictures) as base64 for the page's JSON; everything else as it is. */
export function toWire(v, depth = 0) {
  if (depth > 6) return null;
  if (v instanceof ArrayBuffer) return { $b64: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v)) return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Array.isArray(v)) return v.map((x) => toWire(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = toWire(x, depth + 1);
    return out;
  }
  return v;
}

/** What a page needs to draw the picture as it is now, kept up to date from Studio's messages. Pure (tested). */
export class OverlayState {
  constructor() {
    this.latest = new Map();
    this.images = new Map(); // source id -> "source" (bitmap) or "image" message
    this.chats = new Map(); // channel -> messages
    this.icons = {};
    this.emotes = {};
    this.stickers = new Map(); // spot -> message
    this.banner = null; // { msg, until }
    this.aux = new Map(); // "avatar3d" | "effects3d" -> { start, last: Map<type, msg> }
  }

  /** Takes one of Studio's messages; true when pages should get it. */
  take(m, now = Date.now()) {
    if (!m || typeof m !== "object" || typeof m.type !== "string") return false;
    const t = m.type;
    if (LATEST.has(t)) this.latest.set(t, m);
    else if (t === "source" || t === "image") {
      if (typeof m.id !== "string") return false;
      this.images.set(m.id, m);
    } else if (t === "removeSource") this.images.delete(m.id);
    else if (t === "chat") {
      const k = String(m.channel ?? "").toLowerCase();
      const list = this.chats.get(k) ?? [];
      list.push(m.msg);
      if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT);
      this.chats.set(k, list);
    } else if (t === "chatList") this.chats.set(String(m.channel ?? "").toLowerCase(), Array.isArray(m.msgs) ? m.msgs.slice(-MAX_CHAT) : []);
    else if (t === "chatIcons") Object.assign(this.icons, m.icons ?? {});
    else if (t === "chatEmotes") {
      for (const u of m.drop ?? []) delete this.emotes[u];
      Object.assign(this.emotes, m.emotes ?? {});
    } else if (t === "stickers") {
      if (Array.isArray(m.arts) && m.arts.length) this.stickers.set(m.spot, m);
      else this.stickers.delete(m.spot);
    } else if (t === "banner") this.banner = m.text ? { msg: m, until: now + Math.max(2, Math.min(600, Number(m.seconds) || 0)) * 1000 } : null;
    else if (t === "aux") {
      // The 3D avatar and effects: how they started, and the latest of each setting (a pose only matters as it happens).
      const kind = m.kind, type = m.msg?.type;
      if ((kind !== "avatar3d" && kind !== "effects3d") || typeof type !== "string") return false;
      if (type === "start") this.aux.set(kind, { start: m, last: new Map() });
      else if (type === "stop") this.aux.delete(kind);
      else if (!AUX_PASS.has(type)) this.aux.get(kind)?.last.set(type, m);
    } else if (t === "rtc") return typeof m.to === "string";
    else if (!PASS.has(t)) return false;
    return true;
  }

  /** Everything a page that just connected needs, in an order the compositor can take. */
  replay(now = Date.now()) {
    const out = [];
    for (const t of ["config", "theme", "live", "watermark", "overlayData", "standDown", "soundLevels", "vtuber", "agent"]) {
      const m = this.latest.get(t);
      if (m) out.push(m);
    }
    for (const m of this.images.values()) out.push(m);
    if (Object.keys(this.icons).length) out.push({ type: "chatIcons", icons: this.icons });
    if (Object.keys(this.emotes).length) out.push({ type: "chatEmotes", emotes: this.emotes, drop: [] });
    for (const [channel, msgs] of this.chats) out.push({ type: "chatList", channel, msgs });
    for (const m of this.stickers.values()) out.push(m);
    if (this.banner && this.banner.until > now) out.push({ ...this.banner.msg, seconds: (this.banner.until - now) / 1000 });
    for (const a of this.aux.values()) out.push(a.start, ...a.last.values());
    for (const t of ["planes", "vplanes", "scene", "vscene"]) {
      const m = this.latest.get(t);
      if (m) out.push(t === "scene" || t === "vscene" ? { ...m, fade: false } : m);
    }
    return out;
  }
}

export class OverlayFeed {
  constructor({ log = () => void 0, fetchImpl = globalThis.fetch, onPage = () => void 0 } = {}) {
    this.log = log;
    /** A page's own messages for Studio: it's up ("hello", with which page it is), and its side of a connection. */
    this.onPage = onPage;
    this.fetch = fetchImpl;
    this.origin = null;
    this.scripts = new Map();
    this.key = crypto.randomBytes(16).toString("hex");
    this.state = new OverlayState();
    this.server = null;
    this.wss = null;
    this.ready = null;
  }

  /** Starts (once) and says where pages are: { port, key }. origin: Studio's site, where its scripts come from. */
  start(origin) {
    if (/^https:\/\/[^/\s]+$/.test(origin ?? "") || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin ?? "")) {
      if (origin !== this.origin) this.scripts.clear();
      this.origin = origin;
    }
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.serve(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
      server.on("upgrade", (req, socket, head) => {
        let ok = false;
        try {
          const u = new URL(req.url ?? "", "http://127.0.0.1");
          ok = u.pathname === "/feed" && u.searchParams.get("key") === this.key && wss.clients.size < MAX_CLIENTS;
        } catch {
          ok = false;
        }
        if (!ok) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (d, binary) => {
            if (binary) return;
            let m;
            try {
              m = JSON.parse(String(d));
            } catch {
              return;
            }
            const page = typeof m?.page === "string" ? m.page : typeof m?.from === "string" ? m.from : "";
            if (!/^[mv]\d{1,2}$/.test(page)) return;
            if (m.type === "hello") ws.page = page;
            else if (m.type !== "rtc" || ws.page !== page) return;
            this.onPage(m);
          });
          for (const m of this.state.replay()) this.sendTo(ws, m);
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.wss = wss;
        resolve({ port: server.address().port, key: this.key });
      });
    });
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async serve(req, res) {
    const done = (code, type, body) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(body);
    };
    let path = "";
    try {
      path = new URL(req.url ?? "", "http://127.0.0.1").pathname;
    } catch {
      return done(400, "text/plain", "");
    }
    if (req.method !== "GET") return done(405, "text/plain", "");
    if (path === "/overlay.html") return done(200, "text/html; charset=utf-8", OVERLAY_HTML);
    if (!this.origin) return done(404, "text/plain", "");
    // Anything else the pages load from Studio's site (the 3D avatar's models, the effects' textures), passed on as
    // it is; Studio's scripts are kept once fetched.
    if (!SCRIPT_PATH.test(path)) return this.pass(req, res, path.startsWith("/site/") ? path.slice(5) : path);
    try {
      let body = this.scripts.get(path);
      if (!body) {
        const r = await this.fetch(`${this.origin}${path}`);
        if (!r.ok) return done(r.status === 404 ? 404 : 502, "text/plain", "");
        body = Buffer.from(await r.arrayBuffer());
        if (this.scripts.size >= MAX_SCRIPTS) this.scripts.delete(this.scripts.keys().next().value);
        this.scripts.set(path, body);
      }
      return done(200, "text/javascript; charset=utf-8", body);
    } catch (e) {
      this.log("overlay", "error", `couldn't get ${path}: ${e?.message ?? e}`);
      return done(502, "text/plain", "");
    }
  }

  async pass(req, res, path) {
    try {
      const u = new URL(req.url ?? "", "http://127.0.0.1");
      if (!/^\/[\w./%-]*$/.test(path) || path.includes("..")) throw new Error("bad path");
      const r = await this.fetch(`${this.origin}${path}${u.search}`);
      const type = r.headers.get("content-type") ?? "application/octet-stream";
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.ok ? 200 : r.status === 404 ? 404 : 502, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(r.ok ? body : "");
    } catch (e) {
      this.log("overlay", "error", `couldn't get ${path}: ${e?.message ?? e}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("");
    }
  }

  sendTo(ws, m) {
    if (ws.readyState !== 1) return;
    let s;
    try {
      s = JSON.stringify(toWire(m));
    } catch (e) {
      this.log("overlay", "error", `couldn't send ${m?.type}: ${e?.message ?? e}`);
      return;
    }
    if (s.length > MAX_MESSAGE) return;
    // A page that can't keep up skips what it's behind on, never the app.
    if (ws.bufferedAmount > MAX_MESSAGE) return;
    ws.send(s);
  }

  /** One of Studio's compositor messages (or its side of a connection to one page). */
  post(m) {
    if (!this.state.take(m)) return;
    if (!this.wss) return;
    for (const ws of this.wss.clients) if (m.type !== "rtc" || ws.page === m.to) this.sendTo(ws, m);
  }

  stop() {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.server?.close();
    this.server = this.wss = this.ready = null;
    this.state = new OverlayState();
  }
}
