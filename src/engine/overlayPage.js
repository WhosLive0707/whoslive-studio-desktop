// The page the engine shows for Studio's overlays (overlayFeed.js serves it on this PC). Kept as plain HTML and script
// with no build step: it only starts Studio's own compositor (and its 3D avatar and effects) and passes them what Studio
// sends.
export const OVERLAY_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>WhosLive Studio overlay</title>
<style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
canvas{position:fixed;left:0;top:0;width:100vw;height:100vh}
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
// Studio's overlays on the app's OBS engine stream. The engine shows this page as a see-through browser source (like a
// StreamElements overlay in OBS). It runs Studio's own compositor script (passed on by the app from Studio's site) and
// draws one plane of Studio's layers from what Studio sends the app: widgets and pictures from Studio's messages,
// videos and phone cameras over a connection to Studio on this PC, and the 3D avatar and effects by running Studio's
// own scripts for them here. Everything comes from the app on this PC.
(function () {
  var q = new URLSearchParams(location.search);
  var num = function (k, d, lo, hi) { var n = Math.round(Number(q.get(k))); return isFinite(n) && n >= lo && n <= hi ? n : d; };
  var W = num("w", 1920, 16, 7680), H = num("h", 1080, 16, 4320), FPS = num("fps", 30, 1, 60);
  var key = q.get("key") || "", plane = String(num("plane", 0, 0, 64)), worker = q.get("worker") || "";
  // The vertical picture's planes take Studio's vertical scene.
  var vertical = q.get("canvas") === "v";
  var page = (vertical ? "v" : "m") + plane;
  var SCRIPT = /^\/assets\/[\w.-]+\.js$/;
  // Studio's compositor script, as the app passes it on from Studio's site.
  if (!/^[0-9a-f]{32}$/.test(key) || !SCRIPT.test(worker)) return;
  var cv = document.getElementById("c");
  cv.width = W;
  cv.height = H;
  var off = cv.transferControlToOffscreen();
  var wk = new Worker(new URL(worker, location.href).href, { type: "module" });
  wk.postMessage({ type: "initCanvas", canvas: off, fps: FPS }, [off]);
  var ws = null;
  var send = function (m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  var fromB64 = function (s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  var unwire = function (v) {
    if (Array.isArray(v)) return v.map(unwire);
    if (v && typeof v === "object") {
      if (typeof v.$b64 === "string") return fromB64(v.$b64);
      var o = {};
      for (var k in v) o[k] = unwire(v[k]);
      return o;
    }
    return v;
  };
  var bmp = function (p) {
    return p && p.png ? createImageBitmap(new Blob([p.png], { type: "image/png" })).catch(function () { return null; }) : Promise.resolve(null);
  };
  var pics = function (o) {
    var out = {}, list = [];
    return Promise.all(Object.keys(o || {}).map(function (k) {
      return bmp(o[k]).then(function (b) { if (b) { out[k] = b; list.push(b); } });
    })).then(function () { return { map: out, list: list }; });
  };

  // Videos and phone cameras: Studio sends their pictures over a connection on this PC; each one feeds the compositor
  // as the Studio source it is.
  var pc = null;
  var feeds = {};
  var stopFeed = function (id) {
    var f = feeds[id];
    if (!f) return;
    delete feeds[id];
    f.stop = true;
    try { f.reader.cancel(); } catch (e) {}
    wk.postMessage({ type: "removeSource", id: id });
  };
  var feed = function (id, track) {
    stopFeed(id);
    if (typeof MediaStreamTrackProcessor !== "function") return;
    var ch = new MessageChannel();
    var reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();
    var f = { reader: reader, stop: false };
    feeds[id] = f;
    wk.postMessage({ type: "source", id: id, port: ch.port1 }, [ch.port1]);
    var pump = function () {
      reader.read().then(function (r) {
        if (r.done || f.stop) { if (r.value) r.value.close(); return; }
        try { ch.port2.postMessage(r.value, [r.value]); } catch (e) { r.value.close(); }
        pump();
      }, function () {});
    };
    pump();
  };
  var rtc = function (m) {
    if (!m.sdp || m.sdp.type !== "offer") return null;
    if (pc) try { pc.close(); } catch (e) {}
    for (var id in feeds) stopFeed(id);
    var streams = m.streams || {};
    pc = new RTCPeerConnection({ iceServers: [] });
    var mine = pc;
    pc.ontrack = function (e) {
      var s = e.streams && e.streams[0];
      var id = s && streams[s.id];
      if (id && mine === pc) feed(id, e.track);
    };
    return pc.setRemoteDescription(m.sdp)
      .then(function () { return pc.createAnswer(); })
      .then(function (a) { return pc.setLocalDescription(a); })
      .then(function () {
        // Everything is on this PC: wait for the local candidates, then answer once.
        return new Promise(function (res) {
          if (mine.iceGatheringState === "complete") return res();
          mine.addEventListener("icegatheringstatechange", function () { if (mine.iceGatheringState === "complete") res(); });
          setTimeout(res, 2000);
        });
      })
      .then(function () { if (mine === pc) send({ type: "rtc", from: page, sdp: { type: mine.localDescription.type, sdp: mine.localDescription.sdp } }); })
      .catch(function () {});
  };

  // The 3D avatar and the 3D effects: Studio's own scripts for them run here, told what Studio tells its own.
  var aux = {};
  var stopAux = function (kind) {
    var a = aux[kind];
    if (!a) return;
    delete aux[kind];
    try { a.w.postMessage({ type: "stop" }); } catch (e) {}
    setTimeout(function () { try { a.w.terminate(); } catch (e) {} }, 500);
    if (kind === "avatar3d") {
      wk.postMessage({ type: "removeSource", id: "@avatar3d" });
      wk.postMessage({ type: "avatar3d", on: false });
    } else {
      wk.postMessage({ type: "removeSource", id: "@fx3d-back" });
      wk.postMessage({ type: "removeSource", id: "@fx3d-front" });
    }
  };
  var startAux = function (kind, m) {
    stopAux(kind);
    if (!SCRIPT.test(m.worker || "")) return;
    var w = new Worker(new URL(m.worker, location.href).href, { type: "module" });
    aux[kind] = { w: w };
    if (kind === "avatar3d") {
      var ch = new MessageChannel();
      var size = num2(m.width, 512);
      w.postMessage({ type: "init", port: ch.port2, width: size, height: num2(m.height, size) }, [ch.port2]);
      wk.postMessage({ type: "source", id: "@avatar3d", port: ch.port1 }, [ch.port1]);
      wk.postMessage({ type: "avatar3d", on: true });
    } else {
      var b = new MessageChannel(), f = new MessageChannel();
      w.postMessage({ type: "init", back: b.port2, front: f.port2, width: num2(m.width, W), height: num2(m.height, H) }, [b.port2, f.port2]);
      wk.postMessage({ type: "source", id: "@fx3d-back", port: b.port1 }, [b.port1]);
      wk.postMessage({ type: "source", id: "@fx3d-front", port: f.port1 }, [f.port1]);
    }
    w.postMessage({ type: "stream", ms: 4, periodMs: 1000 / FPS, fps: FPS });
  };
  var num2 = function (v, d) { var n = Math.round(Number(v)); return isFinite(n) && n >= 16 && n <= 7680 ? n : d; };
  var onAux = function (m) {
    var kind = m.kind === "effects3d" ? "effects3d" : m.kind === "avatar3d" ? "avatar3d" : null;
    var msg = m.msg || {};
    if (!kind || typeof msg.type !== "string") return;
    if (msg.type === "start") return startAux(kind, msg);
    if (msg.type === "stop") return stopAux(kind);
    if (aux[kind]) aux[kind].w.postMessage(msg);
  };

  var handle = function (m) {
    switch (m.type) {
      case "planes":
      case "vplanes": {
        if ((m.type === "vplanes") !== vertical) return null;
        var p = (m.planes || {})[plane] || { layers: [], top: false };
        var tracks = p.tracks || [];
        for (var id in feeds) if (tracks.indexOf(id) < 0) stopFeed(id);
        wk.postMessage({ type: "plane", layers: p.layers || [], top: !!p.top, fxBack: p.fxBack });
        return null;
      }
      case "scene":
        if (!vertical) wk.postMessage(m);
        return null;
      case "vscene":
        if (vertical) wk.postMessage({ type: "scene", scene: m.scene, fade: false });
        return null;
      case "rtc":
        // Not in the chain: the pictures keep coming while the connection is made.
        if (m.to === page) rtc(m);
        return null;
      case "aux":
        onAux(m);
        return null;
      case "source":
        return bmp(m.bitmap).then(function (b) { if (b) wk.postMessage({ type: "source", id: m.id, bitmap: b }, [b]); });
      case "image":
        if (m.data instanceof ArrayBuffer) wk.postMessage({ type: "image", id: m.id, data: m.data, mime: m.mime }, [m.data]);
        return null;
      case "chatIcons":
        return pics(m.icons).then(function (r) { wk.postMessage({ type: "chatIcons", icons: r.map }, r.list); });
      case "chatEmotes":
        return pics(m.emotes).then(function (r) { wk.postMessage({ type: "chatEmotes", emotes: r.map, drop: m.drop || [] }, r.list); });
      case "stickers":
        return Promise.all((m.arts || []).map(bmp)).then(function (bs) {
          var arts = bs.filter(Boolean);
          wk.postMessage({ type: "stickers", spot: m.spot, arts: arts }, arts);
        });
      default:
        wk.postMessage(m);
        return null;
    }
  };
  // In order: a picture that's still being decoded holds back what comes after it.
  var chain = Promise.resolve();
  var connect = function () {
    ws = new WebSocket("ws://" + location.host + "/feed?key=" + key);
    ws.onopen = function () { send({ type: "hello", page: page }); };
    ws.onmessage = function (e) {
      var m;
      try { m = unwire(JSON.parse(e.data)); } catch (err) { return; }
      if (!m || typeof m.type !== "string") return;
      chain = chain.then(function () { return handle(m); }).catch(function () {});
    };
    ws.onclose = function () { setTimeout(connect, 1000); };
  };
  connect();
})();
</script>
</body>
</html>
`;
