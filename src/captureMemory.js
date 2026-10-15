// Which screen or window each of Studio's screen shares showed, so the app shares the same one again the next time
// Studio opens (a browser asks every time; the app remembers). Kept in the app's settings. Pure: matched against
// what's on the computer at the time.

/**
 * id: the app's source id ("screen:0:0", "window:123:0"); name: what it was called; audio: system sound came along.
 * @typedef {{ id: string, name: string, audio: boolean, at: number }} CapturePick
 * @typedef {Record<string, CapturePick>} CapturePicks
 */

/** The most shares remembered (the oldest go first). */
export const MAX_PICKS = 40;

/** A key Studio may use: a capture's id. */
export const captureKeyOk = (k) => typeof k === "string" && /^[\w:.-]{1,80}$/.test(k);
const sourceIdOk = (v) => typeof v === "string" && /^(screen|window):[\w:.-]{1,60}$/.test(v);

/** @returns {CapturePicks} */
export function cleanPicks(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const all = Object.entries(raw)
    .flatMap(([k, p]) => {
      if (!captureKeyOk(k) || !p || typeof p !== "object" || !sourceIdOk(p.id)) return [];
      const at = typeof p.at === "number" && Number.isFinite(p.at) ? p.at : 0;
      return [[k, { id: p.id, name: typeof p.name === "string" ? p.name.slice(0, 200) : "", audio: p.audio === true, at }]];
    })
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_PICKS);
  return Object.fromEntries(all);
}

/** What was picked for `key` this time, remembered (the oldest forgotten past MAX_PICKS). */
export function rememberPick(all, key, pick, now) {
  if (!captureKeyOk(key) || !sourceIdOk(pick?.id)) return all;
  return cleanPicks({ ...all, [key]: { id: pick.id, name: pick.name, audio: pick.audio === true, at: now } });
}

/**
 * The screen or window to share again: the same one by its id (a screen keeps its id; a window keeps its while it's
 * open), else the only one of that kind with the same name (a window opened again, a screen renumbered). Several with
 * that name, or none: null, and Studio asks.
 */
export function findAgain(pick, sources) {
  const exact = sources.find((s) => s.id === pick.id);
  if (exact) return exact;
  const kind = pick.id.startsWith("screen:") ? "screen:" : "window:";
  const same = pick.name ? sources.filter((s) => s.id.startsWith(kind) && s.name === pick.name) : [];
  return same.length === 1 ? same[0] : null;
}
