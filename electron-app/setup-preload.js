const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edifi', {
  detectOD: () => ipcRenderer.invoke('detect-od'),
  register: (data) => ipcRenderer.invoke('register', data),
  getStatus: () => ipcRenderer.invoke('get-status'),
});
