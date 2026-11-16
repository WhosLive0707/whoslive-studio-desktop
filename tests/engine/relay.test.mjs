import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { bridgeArgs, pressure, relayUrl, relayUrlOk, RelayLink } from "../../src/engine/relay.js";

test("ffmpeg listens on this PC only and copies the stream into live Matroska", () => {
  const a = bridgeArgs(51234, "abc");
  assert.ok(a.includes("rtmp://127.0.0.1:51234/live/abc"));
  assert.deepEqual(a.slice(a.indexOf("-c"), a.indexOf("-c") + 2), ["-c", "copy"]);
  assert.ok(a.includes("matroska"));
  assert.equal(a[a.indexOf("-live") + 1], "1");
});

test("only WhosLive's relay (or a local test relay) is accepted; AAC is announced", () => {
  assert.equal(relayUrlOk("wss://relay.whoslive.io/ingest?t=x"), true);
  assert.equal(relayUrlOk("wss://evil.example/ingest?t=x"), false);
  assert.equal(relayUrlOk("ws://127.0.0.1:9000/ingest?t=x"), true);
  assert.equal(relayUrl("wss://relay.whoslive.io/ingest?t=x"), "wss://relay.whoslive.io/ingest?t=x&a=aac");
});

test("backpressure: pause over 2 s waiting, resume under 0.5 s", () => {
  const sec = (s, kbps) => (s * kbps * 1000) / 8;
  assert.equal(pressure(sec(2.5, 6000), 6000, false), "pause");
  assert.equal(pressure(sec(1, 6000), 6000, true), null);
  assert.equal(pressure(sec(0.2, 6000), 6000, true), "resume");
});

class FakeWS {
  static last = null;
  static reset() {
    FakeWS.last = null;
  }
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeWS.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: "ready", sid: "s1", dests: ["Twitch"], dry: false }) });
    }, 5);
  }
  send(d) {
    this.sent.push(d);
  }
  close(code, reason) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function fakeSpawn() {
  const p = new EventEmitter();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = () => p.emit("exit", null);
  fakeSpawn.last = p;
  return p;
}

test("a link: the local listener first, then the relay; messages pass through, bytes are forwarded, it ends cleanly", async () => {
  FakeWS.reset();
  const link = new RelayLink({ ffmpeg: "ffmpeg.exe", url: "ws://127.0.0.1:9/ingest?t=tok", kbps: 6000, WebSocketImpl: FakeWS, spawnImpl: fakeSpawn });
  const events = [];
  link.on("open", () => events.push("open"));
  link.on("relay", (m) => events.push(`relay:${m.type}`));
  const closed = new Promise((r) => link.on("closed", r));
  const opened = new Promise((r) => link.on("open", r));
  await link.prepare();
  assert.equal(FakeWS.last, null); // nothing goes to the relay until OBS has its target
  link.connect();
  await opened;
  await new Promise((r) => setTimeout(r, 5));
  assert.match(FakeWS.last.url, /a=aac$/);
  assert.match(link.rtmp.server, /^rtmp:\/\/127\.0\.0\.1:\d+\/live$/);
  assert.deepEqual(events, ["open", "relay:ready"]);
  fakeSpawn.last.stdout.write(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWS.last.sent.length, 1);
  link.end();
  assert.deepEqual(JSON.parse(FakeWS.last.sent[1]), { type: "end" });
  const c = await closed;
  assert.equal(c.code, 1000);
  assert.equal(c.wasOpen, true);
});

test("ffmpeg dying closes the link so Studio reconnects", async () => {
  const link = new RelayLink({ ffmpeg: "ffmpeg.exe", url: "ws://127.0.0.1:9/ingest?t=tok", kbps: 6000, WebSocketImpl: FakeWS, spawnImpl: fakeSpawn });
  const closed = new Promise((r) => link.on("closed", r));
  await link.start();
  fakeSpawn.last.emit("exit", 1);
  const c = await closed;
  assert.equal(c.code, 4500);
});

test("not a relay address: refused before anything starts", async () => {
  const link = new RelayLink({ ffmpeg: "ffmpeg.exe", url: "wss://evil.example/x", kbps: 6000, WebSocketImpl: FakeWS, spawnImpl: fakeSpawn });
  await assert.rejects(link.start(), /Not a WhosLive relay/);
});
