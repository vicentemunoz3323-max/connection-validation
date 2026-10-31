const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('protector', {
  info: () => ipcRenderer.invoke('prot-info'),
  desbloquear: (pass) => ipcRenderer.invoke('prot-desbloquear', pass),
  cerrarPrevia: () => ipcRenderer.invoke('prot-cerrar-previa')
});
