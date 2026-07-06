const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("edifi", {
  detectOD: () => ipcRenderer.invoke("detect-od"),
  register: (data) => ipcRenderer.invoke("register", data),
  getStatus: () => ipcRenderer.invoke("get-status"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  diagPortStatus: () => ipcRenderer.invoke("diag-port-status"),
  diagListenerPorts: () => ipcRenderer.invoke("diag-listener-ports"),
  diagServiceStatus: (service) =>
    ipcRenderer.invoke("diag-service-status", { service }),
  diagEConnectorLog: () => ipcRenderer.invoke("diag-econnector-log"),
  diagRestAuth: () => ipcRenderer.invoke("diag-rest-auth"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
