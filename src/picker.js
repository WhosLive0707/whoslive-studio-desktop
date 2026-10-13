import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import { randomUUID } from "node:crypto";

const kindOf = (id) => id.startsWith("screen:") ? "screen" : "window";
export async function pickCaptureSource(parent, o) {
  const token = randomUUID();
  const win2 = new BrowserWindow({
    parent: parent ?? void 0,
    modal: !!parent,
    width: 860,
    height: 620,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: "Choose what to share",
    backgroundColor: "#070b12",
    autoHideMenuBar: true,
    icon: o.icon,
    webPreferences: { preload: o.preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win2.setMenu(null);
  const list = (kind) => desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 336, height: 189 }, fetchWindowIcons: kind === "window" }).then((all) => all.filter((s) => !o.exclude.has(s.id))).catch(() => []);
  const listing = { screen: list("screen"), window: list("window") };
  const listCh = `picker:list:${token}`;
  const doneCh = `picker:done:${token}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler(listCh);
      ipcMain.removeAllListeners(doneCh);
      if (!win2.isDestroyed()) win2.close();
      resolve(r);
    };
    ipcMain.handle(listCh, async (e, kind) => {
      if (e.sender !== win2.webContents || kind !== "screen" && kind !== "window") return null;
      const sources2 = await listing[kind];
      const items = sources2.map((s) => ({
        id: s.id,
        name: s.name,
        kind: kindOf(s.id),
        thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      }));
      return { items, audio: o.audio && process.platform === "win32" };
    });
    ipcMain.on(doneCh, (e, choice) => {
      if (e.sender !== win2.webContents) return;
      const id = typeof choice?.id === "string" ? choice.id : null;
      if (!id) return finish(null);
      void listing[kindOf(id)].then((sources2) => {
        const src = sources2.find((s) => s.id === id);
        finish(src ? { source: src, audio: choice?.audio === true } : null);
      });
    });
    win2.on("closed", () => finish(null));
    win2.once("ready-to-show", () => win2.show());
    win2.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void win2.loadFile(o.page, { query: { t: token } }).catch(() => finish(null));
  });
}
