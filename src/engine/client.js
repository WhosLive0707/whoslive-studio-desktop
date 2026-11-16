// The app's side of the native engine: starts engine-host.cjs (host.js) as a utility process, sends it Studio's
// calls and passes its events back to the Studio window that started it.
//
// Only the downloadable app has the engine, and only when obs-studio-node was packaged with it (resources/
// obs-studio-node). Studio checks `whosliveDesktop.engine` and keeps its browser capture and encoder when it's absent.
import { app, BrowserWindow, screen, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";

const DIST = __dirname;

/** Where obs-studio-node is: next to the app's resources when installed, vendor/ when run from the repo. */
export function engineDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "obs-studio-node");
  // From the repo (npm start, CI's smoke test): vendor/, or WL_ENGINE_DIR.
  return path.resolve(process.env.WL_ENGINE_DIR || path.join(app.getAppPath(), "vendor", "obs-studio-node"));
}

/** Windows, with OBS's engine packaged in. */
export function engineAvailable() {
  if (process.platform !== "win32") return false;
  const dir = engineDir();
  return fs.existsSync(path.join(dir, "obs64.exe")) && fs.existsSync(path.join(dir, "index.js"));
}

/** Calls Studio may make, and how long each may take (a stream start waits for the relay). */
const CALLS = { init: 60_000, devices: 20_000, setScene: 10_000, setAudio: 5_000, preview: 5_000, startStream: 60_000, stopStream: 10_000, reconnectStream: 60_000 };

export class EngineClient {
  constructor({ version, log = () => void 0 }) {
    this.version = version;
    this.log = log;
    this.proc = null;
    this.ready = null;
    this.seq = 0;
    this.waiting = new Map();
    this.owner = null;
  }

  /** The Studio window that gets the engine's events (the last one that called it). */
  setOwner(wc) {
    if (this.owner === wc) return;
    this.owner = wc;
    wc.once("destroyed", () => {
      if (this.owner !== wc) return;
      this.owner = null;
      // Nobody is looking at Studio any more: end any stream cleanly and let OBS go.
      void this.call("stopStream").catch(() => undefined).finally(() => this.stop());
    });
  }

  send(event, data) {
    const wc = this.owner;
    if (wc && !wc.isDestroyed()) wc.send("engine:event", event, data);
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = utilityProcess.fork(path.join(DIST, "engine-host.cjs"), [], { serviceName: "WhosLive Studio Engine", stdio: "pipe" });
      this.proc = proc;
      proc.stdout?.on("data", (d) => this.log("engine", "info", String(d).trim()));
      proc.stderr?.on("data", (d) => this.log("engine", "error", String(d).trim()));
      let hello = false;
      proc.on("message", (m) => {
        if (m && typeof m.id === "number") {
          const w = this.waiting.get(m.id);
          if (!w) return;
          this.waiting.delete(m.id);
          clearTimeout(w.timer);
          if (m.ok) w.resolve(m.result);
          else w.reject(new Error(m.error || "Engine error"));
          return;
        }
        if (m?.event === "hello" && !hello) {
          hello = true;
          resolve(proc);
          return;
        }
        if (m?.event === "log") this.log(m.data?.stage ?? "engine", m.data?.level ?? "info", m.data?.msg ?? "");
        else if (m?.event) this.send(m.event, m.data);
      });
      proc.on("exit", (code) => {
        const crashed = this.proc === proc && !this.stopping;
        this.proc = null;
        this.ready = null;
        this.initDone = null;
        this.stopping = false;
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer);
          w.reject(new Error("The engine stopped"));
        }
        this.waiting.clear();
        if (!hello) reject(new Error(`The engine couldn't start (exit ${code})`));
        // Studio shows it and falls back; the next call starts a fresh engine.
        if (crashed) this.send("crashed", { code });
      });
    });
    return this.ready;
  }

  async call(type, args) {
    if (!(type in CALLS)) throw new Error(`Unknown engine call ${type}`);
    if (type !== "init" && !this.proc) {
      if (type === "stopStream") return { ok: true };
      await this.init();
    }
    const proc = await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The engine didn't answer (${type})`));
      }, CALLS[type]);
      this.waiting.set(id, { resolve, reject, timer });
      proc.postMessage({ id, type, args });
    });
  }

  init() {
    if (!this.initDone) {
      this.initDone = this.call("init", { dir: engineDir(), appData: path.join(app.getPath("userData"), "engine"), version: this.version }).catch((e) => {
        this.initDone = null;
        throw e;
      });
    }
    return this.initDone;
  }

  /** Studio's preview tile rectangle (CSS pixels in its page) as the native preview window's place in this window. */
  previewArgs(wc, { rect, show }) {
    const bw = BrowserWindow.fromWebContents(wc);
    if (!bw || !show || !rect) return { show: false };
    const scale = screen.getDisplayMatching(bw.getBounds()).scaleFactor * wc.getZoomFactor();
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      show: true,
      hwnd: bw.getNativeWindowHandle(),
      rect: { x: n(rect.x) * scale, y: n(rect.y) * scale, width: Math.max(1, n(rect.width) * scale), height: Math.max(1, n(rect.height) * scale) },
    };
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.initDone = null;
    this.stopping = true;
    const t = setTimeout(() => proc.kill(), 8000);
    proc.once("exit", () => clearTimeout(t));
    const id = ++this.seq;
    proc.postMessage({ id, type: "shutdown", args: {} });
  }
}
