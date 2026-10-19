const { contextBridge, ipcRenderer } = require('electron');

// API de la ventana de consola de cada Izumi
contextBridge.exposeInMainWorld('izumi', {
  info: () => ipcRenderer.invoke('izu:info'),
  reconectar: () => ipcRenderer.invoke('izu:reconectar'),
  desconectar: () => ipcRenderer.invoke('izu:desconectar'),
  autoReconectar: (on) => ipcRenderer.invoke('izu:auto', on),
  enviar: (texto, fin) => ipcRenderer.invoke('izu:enviar', texto, fin),
  guardarComo: () => ipcRenderer.invoke('izu:guardar-como'),
  carpetaLogs: () => ipcRenderer.invoke('izu:carpeta-logs'),
  reenfocar: () => ipcRenderer.invoke('app:reenfocar'),
  onDatos: (cb) => ipcRenderer.on('izu:datos', (_e, texto) => cb(texto)),
  onEstado: (cb) => ipcRenderer.on('izu:estado', (_e, s) => cb(s))
});
