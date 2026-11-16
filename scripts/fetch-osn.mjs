// Fetches OBS's engine for the app (obs-studio-node: libobs, its plugins and the node binding) into
// vendor/obs-studio-node. Pinned and checked: a different file never gets packaged.
// The engine is GPL-2.0 (docs/native-engine.md, "License"): the app that ships it is too.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const OSN_VERSION = "0.27.33";
export const OSN_SHA256 = "36b3251335f9bdda57f3fba372394c1f42d92a083a16bab3cad1c0aaa24d74f5";
const url = `https://s3-us-west-2.amazonaws.com/obsstudionodes3.streamlabs.com/osn-${OSN_VERSION}-release-win64.tar.gz`;
const tgz = "vendor/osn.tar.gz";

await mkdir("vendor", { recursive: true });
const have = await stat("vendor/obs-studio-node/obs64.exe").then(() => true, () => false);
const marker = await readFile("vendor/obs-studio-node/.version", "utf8").catch(() => "");
if (have && marker.trim() === OSN_VERSION) {
  console.log(`obs-studio-node ${OSN_VERSION} already in vendor/`);
  process.exit(0);
}
console.log(`downloading obs-studio-node ${OSN_VERSION}`);
const res = await fetch(url);
if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz));
const sum = createHash("sha256").update(await readFile(tgz)).digest("hex");
if (sum !== OSN_SHA256) throw new Error(`obs-studio-node checksum mismatch: ${sum}`);
await rm("vendor/obs-studio-node", { recursive: true, force: true });
execFileSync("tar", ["-xzf", tgz, "-C", "vendor"], { stdio: "inherit" });
await rm(tgz);
const { writeFile } = await import("node:fs/promises");
await writeFile("vendor/obs-studio-node/.version", OSN_VERSION);
console.log("obs-studio-node ready in vendor/obs-studio-node");
