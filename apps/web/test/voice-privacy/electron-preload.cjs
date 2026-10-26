const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("voicePrivacyPressTrusted", () =>
  ipcRenderer.invoke("press-trusted"),
);
