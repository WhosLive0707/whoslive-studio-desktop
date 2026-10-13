import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
export function obsDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return path.win32.join(env["APPDATA"] ?? path.win32.join(home, "AppData", "Roaming"), "obs-studio");
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "obs-studio");
  return path.posix.join(env["XDG_CONFIG_HOME"] ?? path.posix.join(home, ".config"), "obs-studio");
}
export function isCollectionName(file2) {
  return /^[^/\\]+\.json$/i.test(file2) && !file2.startsWith(".") && file2 !== "." && file2 !== "..";
}
export function parseIni(text) {
  const out = {};
  let sec = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      sec = m[1] ?? "";
      out[sec] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) (out[sec] ??= {})[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
const isLocalPath = (v) => !!v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v);
export function filesIn(collection) {
  const out = new Set();
  const sources2 = collection?.sources;
  if (!Array.isArray(sources2)) return [];
  for (const s of sources2) {
    const st = s?.settings;
    if (!st || typeof st !== "object") continue;
    for (const k of ["file", "local_file"]) {
      const v = st[k];
      if (typeof v === "string" && isLocalPath(v) && (k !== "local_file" || st["is_local_file"] !== false)) out.add(v);
    }
    for (const k of ["files", "playlist"]) {
      const list = st[k];
      if (Array.isArray(list)) {
        for (const f of list) if (typeof f?.value === "string" && isLocalPath(f.value)) out.add(f.value);
      }
    }
  }
  return [...out];
}
export async function readCanvas(dir) {
  try {
    const g = parseIni(await fs.readFile(path.join(dir, "global.ini"), "utf8"));
    const prof = g["Basic"]?.["ProfileDir"] ?? g["Basic"]?.["Profile"];
    if (!prof || /[/\\]/.test(prof)) return null;
    const b = parseIni(await fs.readFile(path.join(dir, "basic", "profiles", prof, "basic.ini"), "utf8"));
    const width = Number(b["Video"]?.["BaseCX"]);
    const height = Number(b["Video"]?.["BaseCY"]);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}
export class ObsReader {
  constructor(dir = obsDir()) {
    this.dir = dir;
  }
  dir;
  /** The files the last opened collection points at: the only ones file() hands over. */
  allowed = new Set();
  scenesDir() {
    return path.join(this.dir, "basic", "scenes");
  }
  async collections() {
    let names;
    try {
      names = await fs.readdir(this.scenesDir());
    } catch {
      return [];
    }
    const out = [];
    for (const file2 of names.filter(isCollectionName)) {
      try {
        const full = path.join(this.scenesDir(), file2);
        const st = await fs.stat(full);
        let name = file2.replace(/\.json$/i, "");
        try {
          const j = JSON.parse(await fs.readFile(full, "utf8"));
          if (typeof j.name === "string" && j.name.trim()) name = j.name.trim();
        } catch {
          continue;
        }
        out.push({ name, file: file2, modified: st.mtimeMs });
      } catch {
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }
  async read(file2) {
    if (!isCollectionName(file2)) return null;
    try {
      const collection = JSON.parse(await fs.readFile(path.join(this.scenesDir(), file2), "utf8"));
      const files = filesIn(collection);
      this.allowed = new Set(files.map((f) => path.resolve(f)));
      return { collection, canvas: await readCanvas(this.dir), files };
    } catch {
      return null;
    }
  }
  /** One of the last collection's files, or null (not one of them, missing, a folder, or too big). */
  async file(p) {
    const full = path.resolve(p);
    if (!this.allowed.has(full)) return null;
    try {
      const st = await fs.stat(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      const buf = await fs.readFile(full);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      return null;
    }
  }
}
