// CI experiment (not shipped), run in a utility process like the engine (osn-experiment.js starts it): how
// obs-studio-node's second canvas renders a nested scene, for the vertical picture. Main canvas 1920x1080 renders
// scene S; the vertical canvas (1080x1920) renders the items of S assigned to it. Three private "program copy"
// scenes P0..P2 hold the same two colors (red full, green top-left quarter) with their items on no canvas, on the
// vertical canvas and on the main canvas. Round two: which double nestings (S > private V > copy) draw on the vertical
// canvas, in five rows. Screenshots of both canvases tell which nesting draws.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* global require */
const req = require;
// Through the parent (a utility process's own output may not reach CI's log before it's stopped).
const log = (m) => process.parentPort.postMessage(`exp: ${m}`);

(async () => {
  try {
    const dir = path.resolve(process.env.WL_ENGINE_DIR || "vendor/obs-studio-node");
    const osn = req(path.join(dir, "index.js"));
    osn.IPC.host(`wl-exp-${process.pid}`);
    osn.NodeObs.SetWorkingDirectory(dir);
    const code = osn.NodeObs.OBS_API_initAPI({ language: "en-US", appDataPath: path.join(os.tmpdir(), "wl-exp"), version: "exp", crashServerUrl: "" });
    log(`init ${code}`);
    const info = (w, h, fps) => ({ fpsNum: fps, fpsDen: 1, baseWidth: w, baseHeight: h, outputWidth: w, outputHeight: h, outputFormat: 2, colorspace: 2, range: 1, scaleType: 2, fpsType: 1 });
    const ctx = osn.VideoFactory.create();
    ctx.video = info(1920, 1080, 30);
    const vctx = osn.VideoFactory.create();
    vctx.video = info(1080, 1920, 30);
    log(`canvases ${ctx.canvasId} ${vctx.canvasId}`);
    const color = (name, hex, w, h) => osn.InputFactory.create("color_source_v3", name, { color: hex, width: w, height: h });
    const red = color("red", 0xff0000ff, 1920, 1080);
    const green = color("green", 0xff00ff00, 960, 540);
    const S = osn.SceneFactory.create("S");
    const tr = osn.TransitionFactory.create("cut_transition", "T");
    tr.set(S);
    osn.Global.setOutputSource(0, tr);
    const put = (scene, input, video, pos, scale) => {
      const it = scene.add(input);
      if (video !== undefined) {
        try {
          it.video = video;
        } catch (e) {
          log(`set video failed: ${e?.message ?? e}`);
        }
      }
      it.position = pos;
      it.scale = scale;
      return it;
    };
    put(S, red, ctx, { x: 0, y: 0 }, { x: 1, y: 1 });
    put(S, green, ctx, { x: 0, y: 0 }, { x: 1, y: 1 });
    // A blue backdrop on the vertical canvas, so empty spots show.
    const blue = color("blue", 0xffff0000, 1080, 1920);
    put(S, blue, vctx, { x: 0, y: 0 }, { x: 1, y: 1 });
    // Five rows of the vertical picture (384 px each, everything at 0.2): R0 a copy nested straight in S (known to
    // draw); R1 the app's way, S > V (items on the vertical canvas) > copy (items on the vertical canvas); R2 the same
    // with the copy's items on no canvas; R3 S > V > a color straight in V; R4 S > V (items on no canvas) > copy.
    const copy = (name, v) => {
      const P = osn.SceneFactory.createPrivate(name);
      put(P, red, v, { x: 0, y: 0 }, { x: 1, y: 1 });
      put(P, green, v, { x: 0, y: 0 }, { x: 1, y: 1 });
      return P;
    };
    const k = { x: 0.2, y: 0.2 };
    put(S, copy("P0", undefined).source, vctx, { x: 0, y: 0 }, k);
    const nestV = (n, inner, innerVideo) => {
      const V = osn.SceneFactory.createPrivate(`V${n}`);
      put(V, inner, innerVideo, { x: 0, y: 0 }, { x: 1, y: 1 });
      put(S, V.source, vctx, { x: 0, y: 384 * n }, k);
    };
    nestV(1, copy("P1", vctx).source, vctx);
    nestV(2, copy("P2", undefined).source, vctx);
    nestV(3, green, vctx);
    nestV(4, copy("P4", undefined).source, undefined);
    await new Promise((r) => setTimeout(r, 1500));
    const out = path.join(os.tmpdir(), "wl-exp-shots");
    mkdirSync(out, { recursive: true });
    for (const [name, v] of [["main", ctx], ["vertical", vctx]]) {
      try {
        const r = await Promise.race([osn.NodeObs.OBS_content_takeScreenshot(v, out, `${name}-%CCYY`), new Promise((_, no) => setTimeout(() => no(new Error("no screenshot in 15 s")), 15_000))]);
        log(`${name} shot ${JSON.stringify(r)}`);
        const ffmpeg = path.join(dir, "ffmpeg.exe");
        const w = 18, h = name === "main" ? 10 : 40;
        const px = execFileSync(ffmpeg, ["-v", "error", "-i", r.path, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        const at = (x, y) => [...px.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)].join(",");
        if (name === "main") log(`main: top-left ${at(2, 2)} bottom-right ${at(15, 8)}`);
        else for (let n = 0; n < 5; n++) log(`vertical R${n}: top-left ${at(1, 8 * n + 1)} right ${at(15, 8 * n + 4)}`);
      } catch (e) {
        log(`${name} screenshot failed: ${e?.stack ?? e}`);
      }
    }
    log("done");
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    log(`FAILED ${e?.stack ?? e}`);
    process.exit(0);
  }
})();
