import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./names.js";
import { cleanStudioUrl, DEFAULT_STUDIO_URL, movedStudioUrl } from "./studio.js";

export const MAX_LOCAL_PAGES = 200;

const file = () => path.join(app.getPath(DATA_DIR), "settings.json");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

function cleanBounds(v) {
  const b = v;
  const x = num(b?.x), y = num(b?.y), width = num(b?.width), height = num(b?.height);
  return x !== null && y !== null && width && height && width >= 640 && height >= 400 ? { x, y, width, height } : null;
}

export function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    const pages = Array.isArray(j["localPages"]) ? j["localPages"].filter((p) => typeof p === "string" && /\.html?$/i.test(p)) : [];
    const saved = cleanStudioUrl(typeof j["studioUrl"] === "string" ? j["studioUrl"] : null);
    return {
      studioUrl: saved ? movedStudioUrl(saved) : DEFAULT_STUDIO_URL,
      bounds: cleanBounds(j["bounds"]),
      maximized: j["maximized"] === true,
      localPages: pages.slice(-MAX_LOCAL_PAGES),
    };
  } catch {
    return { studioUrl: DEFAULT_STUDIO_URL, bounds: null, maximized: false, localPages: [] };
  }
}

export function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s, null, 2));
  } catch {
    /* not saved: the next start uses what was there */
  }
}
