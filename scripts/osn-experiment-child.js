// CI experiment (not shipped), run in a utility process like the engine (osn-experiment.js starts it): how
// obs-studio-node's second canvas renders a nested scene, for the vertical picture. Main canvas 1920x1080 renders
// scene S; the vertical canvas (1080x1920) renders the items of S assigned to it. Three private "program copy"
// scenes P0..P2 hold the same two colors (red full, green top-left quarter) with their items on no canvas, on the
// vertical canvas and on the main canvas; each is nested into S on the vertical canvas, in its own third of the
// vertical picture. Screenshots of both canvases tell which nesting draws.
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
    const variants = [undefined, vctx, ctx];
    variants.forEach((v, n) => {
      const P = osn.SceneFactory.createPrivate(`P${n}`);
      put(P, red, v, { x: 0, y: 0 }, { x: 1, y: 1 });
      put(P, green, v, { x: 0, y: 0 }, { x: 1, y: 1 });
      // 1920x1080 into a 1080-wide third: scale 0.5625, at y = 640 * n.
      put(S, P.source ?? P, vctx, { x: 0, y: 640 * n }, { x: 0.5625, y: 0.5625 });
      log(`P${n} size ${P.source?.width ?? P.width}x${P.source?.height ?? P.height}`);
    });
    await new Promise((r) => setTimeout(r, 1500));
    const out = path.join(os.tmpdir(), "wl-exp-shots");
    mkdirSync(out, { recursive: true });
    for (const [name, v] of [["main", ctx], ["vertical", vctx]]) {
      try {
        const r = await Promise.race([osn.NodeObs.OBS_content_takeScreenshot(v, out, `${name}-%CCYY`), new Promise((_, no) => setTimeout(() => no(new Error("no screenshot in 15 s")), 15_000))]);
        log(`${name} shot ${JSON.stringify(r)}`);
        const ffmpeg = path.join(dir, "ffmpeg.exe");
        const w = 18, h = name === "main" ? 10 : 32;
        const px = execFileSync(ffmpeg, ["-v", "error", "-i", r.path, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        const at = (x, y) => [...px.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)].join(",");
        if (name === "main") log(`main: top-left ${at(2, 2)} bottom-right ${at(15, 8)}`);
        else for (let n = 0; n < 3; n++) log(`vertical P${n}: top-left ${at(2, 10 * n + 1)} right ${at(15, 10 * n + 4)}`);
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
