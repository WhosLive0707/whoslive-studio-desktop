import { contextBridge, ipcRenderer } from "electron";

const token = new URLSearchParams(window.location.search).get("t") ?? "";
contextBridge.exposeInMainWorld("picker", {
  list: (kind) => ipcRenderer.invoke(`picker:list:${token}`, kind),
  done: (choice) => ipcRenderer.send(`picker:done:${token}`, choice)
});
