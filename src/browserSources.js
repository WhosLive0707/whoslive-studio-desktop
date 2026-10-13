import { BrowserWindow, MessageChannelMain, session } from "electron";

const DEFAULT_CSS = "body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }";
const PARTITION = "persist:browser-sources";
const MAX_SIDE = 3840;
const ISOLATED_WORLD = 1017;
const PAINTED = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))";
const FRESH_MS = 1e3;
export function allWhite(data) {
  if (!data.length) return false;
  if (data.byteOffset % 4 === 0) {
    const px = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    for (let i = 0; i < px.length; i++) if (px[i] !== 4294967295) return false;
    return true;
  }
  for (let i = 0; i < data.length; i++) if (data[i] !== 255) return false;
  return true;
}
const CLEAR = { w: 1, h: 1, data: Buffer.alloc(4) };
const int = (v, lo, hi, d) => typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
export function cleanSourceUrl(raw) {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "file:" ? u.toString() : null;
  } catch {
    return null;
  }
}
export function cleanOpts(o, prev) {
  const url = o?.url === void 0 && prev ? prev.url : cleanSourceUrl(o?.url);
  if (!url) return null;
  return {
    url,
    width: int(o?.width, 16, MAX_SIDE, prev?.width ?? 800),
    height: int(o?.height, 16, MAX_SIDE, prev?.height ?? 600),
    fps: int(o?.fps, 1, 60, prev?.fps ?? 30),
    css: typeof o?.css === "string" ? o.css.slice(0, 2e4) : prev?.css ?? DEFAULT_CSS
  };
}
export class BrowserSources {
  list = new Map();
  n = 0;
  constructor() {
    const s = session.fromPartition(PARTITION);
    s.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
  }
  open(owner, o) {
    const opts = cleanOpts(o);
    if (!opts) throw new Error("A browser source needs an http(s) address");
    const id = `bs${++this.n}`;
    const win2 = new BrowserWindow({
      show: false,
      width: opts.width,
      height: opts.height,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: PARTITION
      }
    });
    win2.webContents.setFrameRate(opts.fps);
    const { port1, port2 } = new MessageChannelMain();
    const bs = { id, win: win2, port: port1, owner, opts, busy: false, next: null, cssKey: null, ready: false, nav: 0, failed: false, fresh: 0 };
    port1.on("message", (e) => {
      if (e.data !== "ack") return;
      bs.busy = false;
      if (bs.next) this.send(bs, bs.next);
    });
    port1.start();
    const wc = win2.webContents;
    wc.on("paint", (_e, _dirty, image) => {
      const { width: w, height: h } = image.getSize();
      if (!w || !h || !bs.ready) return;
      const data = image.toBitmap();
      if (bs.fresh) {
        if (Date.now() < bs.fresh && allWhite(data)) return;
        bs.fresh = 0;
      }
      this.push(bs, { w, h, data });
    });
    wc.on("did-start-navigation", (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      bs.nav++;
      bs.ready = false;
      bs.failed = false;
      this.status(bs, { state: "loading" });
    });
    wc.on("dom-ready", () => void this.whenPainted(bs));
    wc.on("did-fail-load", (_e, code, error, _url, isMain) => {
      if (!isMain || code === -3) return;
      bs.nav++;
      bs.ready = false;
      bs.failed = true;
      this.push(bs, CLEAR);
      this.status(bs, { state: "failed", code, error });
    });
    wc.on("render-process-gone", (_e, d) => {
      if (d.reason === "clean-exit") return;
      bs.nav++;
      bs.ready = false;
      bs.failed = true;
      this.push(bs, CLEAR);
      this.status(bs, { state: "crashed" });
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    owner.postMessage("bs:port", { id }, [port2]);
    this.list.set(id, bs);
    void win2.loadURL(opts.url).catch(() => void 0);
    return id;
  }
  /** The page's CSS goes on, and only once it's on screen do its frames go to Studio. */
  async whenPainted(bs) {
    const nav = bs.nav;
    const stale = () => bs.win.isDestroyed() || bs.nav !== nav || bs.failed;
    if (stale()) return;
    await this.applyCss(bs);
    if (stale()) return;
    await bs.win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: PAINTED }]).catch(() => void 0);
    if (stale()) return;
    bs.ready = true;
    bs.fresh = Date.now() + FRESH_MS;
    this.status(bs, { state: "ready" });
    bs.win.webContents.invalidate();
  }
  push(bs, f) {
    if (bs.busy) bs.next = f;
    else this.send(bs, f);
  }
  send(bs, f) {
    bs.next = null;
    bs.busy = true;
    try {
      bs.port.postMessage({ w: f.w, h: f.h, data: f.data });
    } catch {
      bs.busy = false;
    }
  }
  status(bs, s) {
    if (!bs.owner.isDestroyed()) bs.owner.send("bs:status", bs.id, s);
  }
  async applyCss(bs) {
    const wc = bs.win.webContents;
    if (bs.cssKey) await wc.removeInsertedCSS(bs.cssKey).catch(() => void 0);
    bs.cssKey = bs.opts.css ? await wc.insertCSS(bs.opts.css).catch(() => null) : null;
  }
  mine(owner, id) {
    const bs = this.list.get(id);
    return bs && bs.owner === owner && !bs.win.isDestroyed() ? bs : null;
  }
  update(owner, id, o) {
    const bs = this.mine(owner, id);
    if (!bs) return false;
    const next = cleanOpts(o, bs.opts);
    if (!next) return false;
    const prev = bs.opts;
    bs.opts = next;
    if (next.width !== prev.width || next.height !== prev.height) {
      bs.next = null;
      bs.win.setContentSize(next.width, next.height);
      bs.win.webContents.invalidate();
    }
    if (next.fps !== prev.fps) bs.win.webContents.setFrameRate(next.fps);
    if (next.url !== prev.url) void bs.win.loadURL(next.url).catch(() => void 0);
    else if (next.css !== prev.css) void this.applyCss(bs).then(() => bs.win.isDestroyed() || bs.win.webContents.invalidate());
    return true;
  }
  reload(owner, id) {
    const bs = this.mine(owner, id);
    if (!bs) return false;
    if (bs.win.webContents.isCrashed() || bs.failed) void bs.win.loadURL(bs.opts.url).catch(() => void 0);
    else bs.win.webContents.reloadIgnoringCache();
    return true;
  }
  /** The page's frame, for handing its sound to Studio (see main.ts's screen-share handler). */
  frameOf(owner, id) {
    return this.mine(owner, id)?.win.webContents.mainFrame ?? null;
  }
  close(owner, id) {
    const bs = this.mine(owner, id);
    if (!bs) return false;
    this.drop(bs);
    return true;
  }
  /** Everything a Studio window opened, when it reloads or closes. */
  closeAllFor(owner) {
    for (const bs of [...this.list.values()]) if (bs.owner === owner) this.drop(bs);
  }
  drop(bs) {
    this.list.delete(bs.id);
    try {
      bs.port.close();
    } catch {
    }
    if (!bs.win.isDestroyed()) bs.win.destroy();
  }
  get size() {
    return this.list.size;
  }
}
