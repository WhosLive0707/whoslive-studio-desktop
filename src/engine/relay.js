// The engine's stream to the WhosLive relay.
//
// OBS's own encoder and RTMP output publish to an ffmpeg on this PC (127.0.0.1, a fresh random key per stream),
// which rewraps the stream, untouched, as live Matroska. Its bytes go up the same WebSocket, with the same token
// and messages, that Studio's browser encoder uses (services/studio-relay in the web repo), so the relay, the
// platform keys (which never reach this PC) and billing are exactly as they are today. Nothing is re-encoded.
//
// Congestion: when the upload can't keep up, reading from ffmpeg pauses, so ffmpeg stops reading OBS's RTMP, so
// OBS sees a congested connection and does what OBS does: dynamic bitrate first, then dropping frames properly.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

/** ffmpeg's arguments: listen for one RTMP publish, write it as live Matroska to stdout. */
export function bridgeArgs(port, key) {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-listen", "1", "-f", "flv", "-i", `rtmp://127.0.0.1:${port}/live/${key}`,
    "-map", "0", "-c", "copy",
    "-f", "matroska", "-live", "1", "-cluster_time_limit", "500", "-flush_packets", "1",
    "pipe:1",
  ];
}

/** The relay URL with the audio codec the relay should expect (OBS always sends AAC). */
export function relayUrl(url) {
  return `${url}${url.includes("?") ? "&" : "?"}a=aac`;
}

/** Only WhosLive's relay (or a local one in tests). */
export function relayUrlOk(url) {
  return typeof url === "string" && (/^wss:\/\/relay\.whoslive\.io\/[^\s]*$/.test(url) || /^wss?:\/\/127\.0\.0\.1:\d+\/[^\s]*$/.test(url));
}

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Backpressure thresholds in seconds of stream at the target bitrate. */
export const HIGH_S = 2;
export const LOW_S = 0.5;
export function pressure(bufferedBytes, kbps, paused) {
  const sec = bufferedBytes / ((Math.max(500, kbps) * 1000) / 8);
  if (!paused && sec > HIGH_S) return "pause";
  if (paused && sec < LOW_S) return "resume";
  return null;
}

/**
 * One link to the relay: an ffmpeg listener and a WebSocket. Events: "open" (media can flow: start OBS's output now),
 * "relay" (a relay message, passed through as is), "closed" ({ code, reason, wasOpen }), "stats".
 * A reconnect is a new link (a new token): the relay needs each link to start with a fresh header and a keyframe.
 */
export class RelayLink extends EventEmitter {
  constructor({ ffmpeg, url, kbps, log = () => void 0, WebSocketImpl = globalThis.WebSocket, spawnImpl = spawn }) {
    super();
    this.ffmpeg = ffmpeg;
    this.url = url;
    this.kbps = kbps;
    this.log = log;
    this.WS = WebSocketImpl;
    this.spawn = spawnImpl;
    this.key = randomBytes(12).toString("hex");
    this.port = 0;
    this.proc = null;
    this.ws = null;
    this.opened = false;
    this.closed = false;
    this.paused = false;
    this.bytes = 0;
    this.pending = [];
    this.timer = null;
  }

  /** Where OBS publishes: { server, key }. Valid after start(). */
  get rtmp() {
    return { server: `rtmp://127.0.0.1:${this.port}/live`, key: this.key };
  }

  /** Both steps: the local listener, then the relay. */
  async start() {
    await this.prepare();
    this.connect();
  }

  /** The local ffmpeg listener, ready for OBS to publish to (this.rtmp). Nothing goes to the relay yet. */
  async prepare() {
    if (!relayUrlOk(this.url)) throw new Error("Not a WhosLive relay address");
    this.port = await freePort();
    const proc = this.spawn(this.ffmpeg, bridgeArgs(this.port, this.key), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    let errText = "";
    proc.stderr.on("data", (d) => {
      errText = (errText + d.toString()).slice(-2000);
    });
    proc.on("error", (e) => {
      if (!this.closed) this.log("relay", "error", `bridge failed to start: ${e?.message ?? e}`);
      this.shut(4500, "Local stream bridge couldn't start");
    });
    proc.on("exit", (code) => {
      if (this.closed) return;
      this.log("relay", "error", `bridge exited code=${code} ${errText.replace(/rtmp:\/\/\S+/g, "rtmp://local").slice(-300)}`);
      this.shut(4500, "Local stream bridge stopped");
    });
    proc.stdout.on("data", (chunk) => this.send(chunk));
    // ffmpeg needs a moment to listen before OBS connects (OBS also retries a refused connection).
    await new Promise((r) => setTimeout(r, 600));
    if (this.closed) throw new Error("Local stream bridge stopped");
  }

  /** The WebSocket to the relay. "open" means OBS can start publishing. */
  connect() {
    if (this.closed || this.ws) return;
    const ws = new this.WS(relayUrl(this.url));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.closed) return;
      this.opened = true;
      for (const c of this.pending.splice(0)) this.send(c);
      this.emit("open");
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      this.emit("relay", msg);
    };
    ws.onclose = (e) => this.shut(e?.code ?? 1006, e?.reason ?? "");
    ws.onerror = () => void 0; // onclose follows with the code
    let last = 0, lastT = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const kbps = Math.round(((this.bytes - last) * 8) / Math.max(0.001, (now - lastT) / 1000) / 1000);
      last = this.bytes;
      lastT = now;
      this.emit("stats", { uploadKbps: kbps, bufferedMs: Math.round((this.buffered() / ((this.kbps * 1000) / 8)) * 1000), paused: this.paused });
      this.balance();
    }, 1000);
  }

  buffered() {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** Pause or resume reading from ffmpeg by how much is still waiting to go up. */
  balance() {
    const p = pressure(this.buffered(), this.kbps, this.paused);
    if (p === "pause") {
      this.paused = true;
      this.proc?.stdout.pause();
    } else if (p === "resume") {
      this.paused = false;
      this.proc?.stdout.resume();
    }
  }

  send(chunk) {
    if (this.closed) return;
    if (!this.opened || this.ws?.readyState !== 1) {
      this.pending.push(chunk);
      if (this.pending.length > 4000) this.shut(4500, "Relay didn't open");
      return;
    }
    this.ws.send(chunk);
    this.bytes += chunk.byteLength;
    if (!this.paused && this.buffered() > ((this.kbps * 1000) / 8) * HIGH_S) this.balance();
  }

  /** The streamer ended: the relay ends every platform cleanly, then the link closes. */
  end() {
    if (this.closed) return;
    try {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "end" }));
    } catch {
      /* closing anyway */
    }
    setTimeout(() => this.shut(1000, "streamer ended"), 1500);
  }

  shut(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try {
      if (this.ws && this.ws.readyState <= 1) this.ws.close(code >= 4000 || code === 1000 ? code : 1000, reason.slice(0, 100));
    } catch {
      /* already closed */
    }
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.emit("closed", { code, reason, wasOpen: this.opened });
  }
}
