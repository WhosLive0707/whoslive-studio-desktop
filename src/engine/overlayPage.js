// The page the engine shows for Studio's overlays (overlayFeed.js serves it on this PC). Kept as plain HTML and script
// with no build step: it only starts Studio's own compositor and passes it what Studio sends.
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
// draws one plane of Studio's layers from what Studio sends the app. Everything comes from the app on this PC.
(function () {
  var q = new URLSearchParams(location.search);
  var num = function (k, d, lo, hi) { var n = Math.round(Number(q.get(k))); return isFinite(n) && n >= lo && n <= hi ? n : d; };
  var W = num("w", 1920, 16, 7680), H = num("h", 1080, 16, 4320), FPS = num("fps", 30, 1, 60);
  var key = q.get("key") || "", plane = String(num("plane", 0, 0, 64)), worker = q.get("worker") || "";
  // Studio's compositor script, as the app passes it on from Studio's site.
  if (!/^[0-9a-f]{32}$/.test(key) || !/^\/assets\/[\w.-]+\.js$/.test(worker)) return;
  var url = new URL(worker, location.href);
  var cv = document.getElementById("c");
  cv.width = W;
  cv.height = H;
  var off = cv.transferControlToOffscreen();
  var wk = new Worker(url.href, { type: "module" });
  wk.postMessage({ type: "initCanvas", canvas: off, fps: FPS }, [off]);

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
  var handle = function (m) {
    switch (m.type) {
      case "planes": {
        var p = (m.planes || {})[plane] || { layers: [], top: false };
        wk.postMessage({ type: "plane", layers: p.layers || [], top: !!p.top });
        return null;
      }
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
    var ws = new WebSocket("ws://" + location.host + "/feed?key=" + key);
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
