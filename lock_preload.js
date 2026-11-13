const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lock', {
  info: () => ipcRenderer.invoke('lock:info'),
  recursos: () => ipcRenderer.invoke('lock:recursos'),
  listo: () => ipcRenderer.invoke('lock:listo'),
  desbloquear: (pass) => ipcRenderer.invoke('lock:desbloquear', pass)
});
