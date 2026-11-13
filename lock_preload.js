const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lock', {
  info: () => ipcRenderer.invoke('lock:info'),
  listo: () => ipcRenderer.invoke('lock:listo'),
  desbloquear: (pass) => ipcRenderer.invoke('lock:desbloquear', pass)
});
