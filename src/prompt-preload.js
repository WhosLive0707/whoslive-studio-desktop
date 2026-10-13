import { contextBridge, ipcRenderer } from "electron";

const token = new URLSearchParams(window.location.search).get("t") ?? "";
contextBridge.exposeInMainWorld("ask", {
  init: () => ipcRenderer.invoke(`prompt:init:${token}`),
  check: (v) => ipcRenderer.invoke(`prompt:check:${token}`, v),
  done: (v) => ipcRenderer.send(`prompt:done:${token}`, v)
});
