import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, webContents } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserSources } from "./browserSources.js";
import { CHANNEL } from "./channel.js";
import { AUTOPLAY_FREE, UA_FALLBACK } from "./names.js";
import { ObsReader } from "./obs.js";
import { pickCaptureSource } from "./picker.js";
import { promptText } from "./prompt.js";
import { loadSettings, MAX_LOCAL_PAGES, saveSettings } from "./settings.js";
import { chromeIdentity, cleanStudioUrl, MENU_ACTIONS, openTarget, originOf, STUDIO_CHOICES, trustedOrigins } from "./studio.js";
import { AppUpdates } from "./updates.js";

const DIST = __dirname;
const ICON = path.join(DIST, "icon.png");
const PAGE = (name) => path.join(DIST, "pages", name);
const PAGES_URL = pathToFileURL(path.join(DIST, "pages") + path.sep).href;
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("autoplay-policy", AUTOPLAY_FREE);
app.setAppUserModelId(CHANNEL.appId);
const settings = { studioUrl: "", bounds: null, maximized: false, localPages: [] };
let override = cleanStudioUrl(process.argv.find((a) => a.startsWith("--studio-url="))?.slice("--studio-url=".length));
const studioUrl = () => override ?? settings.studioUrl;
let trusted = new Set();
const refreshTrusted = () => trusted = trustedOrigins(studioUrl());
const isTrusted = (url) => {
  const o = url ? originOf(url) : null;
  return !!o && trusted.has(o);
};
let win = null;
let updates = null;
let sources;
const obs = new ObsReader();
let pendingAudio = null;
const menuItems = new Map();
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
const STUDIO_PERMISSIONS = new Set([
  "media",
  "display-capture",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "notifications",
  "window-management",
  "speaker-selection",
  "fileSystem",
  "screen-wake-lock"
]);
function setUpSession() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(STUDIO_PERMISSIONS.has(permission) && isTrusted(details.requestingUrl || wc.getURL()));
  });
  s.setPermissionCheckHandler((wc, permission, origin) => STUDIO_PERMISSIONS.has(permission) && isTrusted(origin || wc?.getURL()));
  s.setDisplayMediaRequestHandler((req, cb) => {
    const deny = () => cb(null);
    void (async () => {
      if (!req.frame || !isTrusted(req.frame.url)) return deny();
      const owner = webContents.fromFrame(req.frame);
      const p = pendingAudio;
      pendingAudio = null;
      if (p && owner && p.owner === owner && Date.now() - p.at < 1e4) {
        const frame = sources.frameOf(owner, p.id);
        if (frame) return cb({ video: frame, audio: frame, enableLocalEcho: p.hear });
      }
      const parent = owner && BrowserWindow.fromWebContents(owner) || win;
      const pick = await pickCaptureSource(parent, {
        audio: req.audioRequested,
        exclude: new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId())),
        preload: path.join(DIST, "picker-preload.cjs"),
        page: PAGE("picker.html"),
        icon: ICON
      });
      if (!pick) return deny();
      cb(pick.audio ? { video: pick.source, audio: "loopback" } : { video: pick.source });
    })().catch(deny);
  });
}
const pageKey = (p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
function localPageOk(url) {
  if (typeof url !== "string") return true;
  if (!/^file:/i.test(url.trim())) return true;
  try {
    return settings.localPages.includes(pageKey(fileURLToPath(url.trim())));
  } catch {
    return false;
  }
}
function sender(e) {
  if (!isTrusted(e.senderFrame?.url)) throw new Error("Not a Studio page");
  return e.sender;
}
function setUpBridge() {
  ipcMain.on("desktop:hello", (e) => {
    e.returnValue = { trusted: isTrusted(e.senderFrame?.url), version: app.getVersion(), platform: process.platform };
  });
  ipcMain.handle("bs:open", (e, o) => {
    const owner = sender(e);
    if (!localPageOk(o?.url)) throw new Error("A local page opens only after an OBS import brought it in");
    return { id: sources.open(owner, o ?? {}) };
  });
  ipcMain.handle("bs:update", (e, id, o) => {
    const owner = sender(e);
    if (o?.url !== void 0 && !localPageOk(o.url)) return false;
    return sources.update(owner, String(id), o ?? {});
  });
  ipcMain.handle("bs:reload", (e, id) => sources.reload(sender(e), String(id)));
  ipcMain.handle("bs:close", (e, id) => sources.close(sender(e), String(id)));
  ipcMain.handle("bs:audio", (e, id, o) => {
    const owner = sender(e);
    if (!sources.frameOf(owner, String(id))) return false;
    pendingAudio = { owner, id: String(id), at: Date.now(), hear: o?.hear === true };
    return true;
  });
  ipcMain.handle("obs:list", (e) => (sender(e), obs.collections()));
  ipcMain.handle("obs:read", async (e, file2) => {
    sender(e);
    const r = await obs.read(String(file2));
    const pages = (r?.files ?? []).filter((f) => /\.html?$/i.test(f)).map(pageKey);
    if (pages.length) {
      settings.localPages = [...new Set([...settings.localPages, ...pages])].slice(-MAX_LOCAL_PAGES);
      saveSettings(settings);
    }
    return r;
  });
  ipcMain.handle("obs:file", (e, p) => (sender(e), obs.file(String(p))));
  ipcMain.on("desktop:open-external", (e, url) => {
    try {
      sender(e);
    } catch {
      return;
    }
    if (typeof url === "string" && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.on("desktop:menu-items", (e, actions) => {
    let wc;
    try {
      wc = sender(e);
    } catch {
      return;
    }
    const known = Array.isArray(actions) ? actions.filter((a) => typeof a === "string" && a in MENU_ACTIONS) : [];
    menuItems.set(wc, [...new Set(known)]);
    buildMenu();
  });
  ipcMain.on("app:choose-studio", (e) => {
    if (e.senderFrame?.url.startsWith(PAGES_URL)) void chooseStudio();
  });
}
function showProblem(code, url) {
  if (!win || win.isDestroyed()) return;
  void win.loadFile(PAGE("offline.html"), { query: { url, code: String(code) } });
}
function watch(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    const where = openTarget(url, trusted);
    if (where === "app")
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: "#05070f",
          icon: ICON,
          webPreferences: { backgroundThrottling: false }
        }
      };
    if (where === "browser") void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => {
    watch(child.webContents);
    child.setMenuBarVisibility(false);
  });
  wc.on("will-prevent-unload", (e) => {
    const bw = BrowserWindow.fromWebContents(wc) ?? void 0;
    const r = dialog.showMessageBoxSync(bw, {
      type: "warning",
      buttons: ["Close anyway", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "WhosLive Studio",
      message: "Studio is still busy",
      detail: "You may be live or recording. Closing now stops it."
    });
    if (r === 0) e.preventDefault();
  });
  wc.on("destroyed", () => {
    sources.closeAllFor(wc);
    if (menuItems.delete(wc)) buildMenu();
  });
  wc.on("did-start-navigation", (d) => {
    if (!d.isMainFrame || d.isSameDocument) return;
    sources.closeAllFor(wc);
    if (menuItems.delete(wc)) buildMenu();
  });
}
function createWindow() {
  const b = settings.bounds;
  win = new BrowserWindow({
    ...b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1600, height: 950 },
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "WhosLive Studio",
    backgroundColor: "#070b12",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DIST, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: true
    }
  });
  if (settings.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  const wc = win.webContents;
  watch(wc);
  wc.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && isTrusted(url)) showProblem(0, studioUrl());
  });
  wc.on("did-navigate", (_e, url, status) => {
    if (status >= 400 && isTrusted(url)) showProblem(status, studioUrl());
  });
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    const r = dialog.showMessageBoxSync(win, {
      type: "error",
      buttons: ["Reload Studio", "Quit"],
      defaultId: 0,
      title: "WhosLive Studio",
      message: "Studio stopped unexpectedly",
      detail: `(${d.reason})`
    });
    if (r === 0) void win?.loadURL(studioUrl());
    else app.quit();
  });
  win.on("close", () => {
    if (!win) return;
    settings.maximized = win.isMaximized();
    settings.bounds = win.getNormalBounds();
    saveSettings(settings);
  });
  win.on("closed", () => {
    win = null;
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  });
  void win.loadURL(studioUrl()).catch(() => void 0);
}
function useStudio(url) {
  settings.studioUrl = url;
  override = null;
  saveSettings(settings);
  refreshTrusted();
  buildMenu();
  if (win) void win.loadURL(studioUrl()).catch(() => void 0);
}
async function chooseStudio() {
  const url = await promptText(win, {
    title: "Open another Studio",
    label: "Studio address",
    value: studioUrl(),
    placeholder: "https://\u2026",
    ok: "Open",
    check: (v) => cleanStudioUrl(v) ? null : "Type a full address that starts with https://",
    preload: path.join(DIST, "prompt-preload.cjs"),
    page: PAGE("prompt.html"),
    icon: ICON
  });
  const clean = url ? cleanStudioUrl(url) : null;
  if (clean) useStudio(clean);
}
function menuActions() {
  return win && !win.isDestroyed() && menuItems.get(win.webContents) || [];
}
function runMenuAction(action) {
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (wc && menuItems.get(wc)?.includes(action)) wc.send("desktop:menu", action);
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
function buildMenu() {
  const current = studioUrl();
  const actions = menuActions();
  const template = [
    ...process.platform === "darwin" ? [{ role: "appMenu" }] : [],
    {
      label: "Studio",
      submenu: [
        ...STUDIO_CHOICES.map(
          (c) => ({ label: c.label, type: "radio", checked: c.url === current, click: () => useStudio(c.url) })
        ),
        ...STUDIO_CHOICES.some((c) => c.url === current) ? [] : [{ label: hostOf(current), type: "radio", checked: true }],
        { label: "Other address\u2026", click: () => void chooseStudio() },
        ...actions.length ? [
          { type: "separator" },
          ...actions.map((a) => ({ label: MENU_ACTIONS[a] ?? a, click: () => runMenuAction(a) }))
        ] : [],
        { type: "separator" },
        { label: "Reload Studio", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
        { label: "Open Studio in your browser", click: () => void shell.openExternal(current) },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools", accelerator: "CmdOrCtrl+Shift+I" }
      ]
    },
    {
      label: "Help",
      submenu: [
        { label: `${CHANNEL.productName} ${app.getVersion()}`, enabled: false },
        ...updates ? [{ label: updates.menuLabel(), click: () => updates?.menuClick() }] : [],
        { label: "whoslive.io", click: () => void shell.openExternal("https://whoslive.io/") }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
app.whenReady().then(() => {
  Object.assign(settings, loadSettings());
  refreshTrusted();
  sources = new BrowserSources();
  app[UA_FALLBACK] = chromeIdentity(app[UA_FALLBACK] ?? "");
  setUpSession();
  setUpBridge();
  if (app.isPackaged || process.env.WL_UPDATES_TEST) {
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    updates = new AppUpdates({
      updater: autoUpdater,
      version: app.getVersion(),
      ask: (w, o) => w && !w.isDestroyed() ? dialog.showMessageBox(w, o) : dialog.showMessageBox(o),
      windows: () => BrowserWindow.getAllWindows(),
      main: () => win,
      changed: () => buildMenu()
    });
    updates.start();
  }
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (updates?.restarting) return updates.install();
  if (process.platform !== "darwin") app.quit();
});
