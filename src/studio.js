import { CHANNEL } from "./channel.js";

export const DEFAULT_STUDIO_URL = CHANNEL.studioUrl;
export const MENU_ACTIONS = { "obs-import": "Import scenes from OBS…" };

const PROD_URL = "https://studio.whoslive.io/studio";
const DEV_URL = "https://dev-studio.whoslive.io/studio";

export const STUDIO_CHOICES = [
  { id: "prod", label: "WhosLive Studio (studio.whoslive.io)", url: PROD_URL },
  { id: "dev", label: "Dev (dev-studio.whoslive.io)", url: DEV_URL },
];

/**
 * Addresses older versions saved that no longer point at a real Studio: 0.1.1 opened Lovable's copy by default, and
 * its menu opened the sites' landing pages. A saved one moves to its Studio.
 */
const MOVED = {
  "https://whoslive-studio.lovable.app/studio": DEFAULT_STUDIO_URL,
  "https://studio.whoslive.io/": PROD_URL,
  "https://dev-studio.whoslive.io/": DEV_URL,
};
export const movedStudioUrl = (url) => MOVED[url] ?? url;

export function cleanStudioUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const isLocalHost = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function trustedOrigins(current) {
  const out = new Set();
  for (const u of [current, ...STUDIO_CHOICES.map((c) => c.url)]) {
    const o = originOf(u);
    if (o) out.add(o);
  }
  return out;
}

const isBlank = (url) => url === "" || url === "about:blank";

export function openTarget(url, trusted) {
  if (isBlank(url)) return "app";
  const o = originOf(url);
  if (!o) return "deny";
  return trusted.has(o) ? "app" : "browser";
}

export function chromeIdentity(original) {
  return original
    .replace(/\s?Electron\/[\d.]+/i, "")
    .replace(/\s?WhosLive(?:[\s-]?Studio)?\/[\d.]+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
