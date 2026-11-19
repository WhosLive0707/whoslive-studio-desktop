// Bundles src/ into dist/ for the channel in WL_CHANNEL ("prod" or "dev"; anything else is dev).
import { build } from "esbuild";
import { cp, readFile, rm } from "node:fs/promises";

const channels = JSON.parse(await readFile("channels.json", "utf8"));
const key = process.env.WL_CHANNEL === "prod" ? "prod" : "dev";

await rm("dist", { recursive: true, force: true });
const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], logLevel: "warning", banner: { js: "\"use strict\";" } };
await build({ ...common, entryPoints: ["src/main.js"], outfile: "dist/main.cjs", define: { __CHANNEL__: JSON.stringify(channels[key]) } });
// The native engine's process (src/engine/host.js). obs-studio-node is loaded from its own folder at run time.
await build({ ...common, entryPoints: ["src/engine/host.js"], outfile: "dist/engine-host.cjs" });
// CI's smoke test of the real engine (not packaged: electron-builder only takes what the app needs at run time).
if (process.env.WL_SMOKE) await build({ ...common, external: ["electron", "ws"], entryPoints: ["scripts/engine-smoke.js"], outfile: "dist/engine-smoke.cjs" });
if (process.env.WL_SMOKE) await build({ ...common, entryPoints: ["scripts/osn-experiment.js"], outfile: "dist/osn-experiment.cjs" });
if (process.env.WL_SMOKE) await build({ ...common, entryPoints: ["scripts/osn-experiment-child.js"], outfile: "dist/osn-experiment-child.cjs" });
for (const p of ["preload", "picker-preload", "prompt-preload"]) await build({ ...common, entryPoints: [`src/${p}.js`], outfile: `dist/${p}.cjs` });
await cp("src/pages", "dist/pages", { recursive: true });
await cp("assets/icon.png", "dist/icon.png");
console.log(`built ${key}: ${channels[key].studioUrl}`);
