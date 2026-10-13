import { contextBridge, ipcRenderer, webFrame } from "electron";

const hello = ipcRenderer.sendSync("desktop:hello");
if (hello?.trusted) {
  const statusFns = new Set();
  ipcRenderer.on("bs:status", (_e, id, s) => {
    for (const f of statusFns) f(id, s);
  });
  let menuFn = null;
  ipcRenderer.on("desktop:menu", (_e, action) => menuFn?.(action));
  contextBridge.exposeInMainWorld("whosliveDesktop", {
    version: hello.version,
    platform: hello.platform,
    browserSource: {
      open: (o) => ipcRenderer.invoke("bs:open", o),
      update: (id, o) => ipcRenderer.invoke("bs:update", id, o),
      reload: (id) => ipcRenderer.invoke("bs:reload", id),
      close: (id) => ipcRenderer.invoke("bs:close", id),
      /** The next navigator.mediaDevices.getDisplayMedia() call gets this source's sound (and picture) instead of
       *  the screen chooser: how its alert sounds get into the stream. hear: it keeps playing on this computer too. */
      audio: (id, o) => ipcRenderer.invoke("bs:audio", id, { hear: o?.hear === true }),
      /** Every source's status: "loading", "ready", "failed" (code, error) or "crashed". Returns a way to stop. */
      onStatus: (fn) => {
        if (typeof fn !== "function") return () => void 0;
        statusFns.add(fn);
        return () => void statusFns.delete(fn);
      }
    },
    obs: {
      collections: () => ipcRenderer.invoke("obs:list"),
      read: (file) => ipcRenderer.invoke("obs:read", file),
      file: (path) => ipcRenderer.invoke("obs:file", path)
    },
    /** Menu items the app shows for this Studio (e.g. "obs-import"), and what to do when one is picked. Calling it
     *  again replaces them; an empty list takes them away. */
    menu: (actions, fn) => {
      menuFn = typeof fn === "function" ? fn : null;
      ipcRenderer.send("desktop:menu-items", Array.isArray(actions) ? actions.filter((a) => typeof a === "string") : []);
    },
    openExternal: (url) => ipcRenderer.send("desktop:open-external", url)
  });
  void webFrame.executeJavaScript(`(() => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== "function") return;
    const real = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async (c) => {
      try {
        return await real(c);
      } catch (e) {
        if (e && e.name === "AbortError" && /Invalid capture constraints/.test(e.message || "")) throw new DOMException("Permission denied", "NotAllowedError");
        throw e;
      }
    };
  })()`);
  ipcRenderer.on("bs:port", (e, msg) => {
    window.postMessage({ type: "whoslive-desktop:frames", id: msg.id }, window.location.origin, [...e.ports]);
  });
} else if (window.location.protocol === "file:") {
  contextBridge.exposeInMainWorld("whosliveApp", {
    chooseStudio: () => ipcRenderer.send("app:choose-studio")
  });
}
