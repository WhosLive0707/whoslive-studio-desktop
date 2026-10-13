import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";

export function promptText(parent, o) {
  const token = randomUUID();
  const win2 = new BrowserWindow({
    parent: parent ?? void 0,
    modal: !!parent,
    width: 520,
    height: 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: o.title,
    backgroundColor: "#070b12",
    autoHideMenuBar: true,
    icon: o.icon,
    webPreferences: { preload: o.preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win2.setMenu(null);
  const initCh = `prompt:init:${token}`;
  const checkCh = `prompt:check:${token}`;
  const doneCh = `prompt:done:${token}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler(initCh);
      ipcMain.removeHandler(checkCh);
      ipcMain.removeAllListeners(doneCh);
      if (!win2.isDestroyed()) win2.close();
      resolve(v);
    };
    const mine = (e) => e.sender === win2.webContents;
    ipcMain.handle(
      initCh,
      (e) => mine(e) ? { title: o.title, label: o.label, value: o.value, placeholder: o.placeholder ?? "", ok: o.ok ?? "OK" } : null
    );
    ipcMain.handle(checkCh, (e, v) => mine(e) && typeof v === "string" ? o.check(v) : "Not allowed");
    ipcMain.on(doneCh, (e, v) => {
      if (!mine(e)) return;
      if (typeof v !== "string") return finish(null);
      if (o.check(v) === null) finish(v);
    });
    win2.on("closed", () => finish(null));
    win2.once("ready-to-show", () => win2.show());
    win2.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win2.webContents.on("will-navigate", (e) => e.preventDefault());
    void win2.loadFile(o.page, { query: { t: token } }).catch(() => finish(null));
  });
}
