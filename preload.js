const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sistema', {
  // Validación de conexión
  ejecutar: () => ipcRenderer.invoke('run-validation'),
  estado: () => ipcRenderer.invoke('get-estado'),
  onEstado: (cb) => ipcRenderer.on('validation-state', (_e, s) => cb(s)),
  onConsoleLog: (cb) => ipcRenderer.on('console-log', (_e, t) => cb(t)),
  abrirWeb: (id) => ipcRenderer.invoke('open-web', id),

  // Red y archivos
  obtenerIPs: () => ipcRenderer.invoke('get-ips'),
  leerDhcpConfigs: () => ipcRenderer.invoke('read-dhcp-configs'),
  abrirDhcp: (cual) => ipcRenderer.invoke('open-dhcp-files', cual),

  // Instrumentos (ping en segundo plano)
  hacerPing: (ip) => ipcRenderer.invoke('ping-host', ip),
  obtenerInstrumentos: () => ipcRenderer.invoke('get-instrumentos'),
  onInstrumentos: (cb) => ipcRenderer.on('instrumentos-state', (_e, s) => cb(s)),

  // Actualización de rectificadores (comandos en segundo plano)
  cmdsEjecutar: (comandos, detenerSiFalla, limiteMin) => ipcRenderer.invoke('cmds-run', { comandos, detenerSiFalla, limiteMin }),
  cmdsResponder: (texto, datos) => ipcRenderer.invoke('cmds-input', texto, datos || {}),
  cmdsSudoOlvidar: () => ipcRenderer.invoke('cmds-sudo-olvidar'),
  cmdsSudoHay: () => ipcRenderer.invoke('cmds-sudo-hay'),
  cmdsDetener: () => ipcRenderer.invoke('cmds-stop'),
  cmdsEstado: () => ipcRenderer.invoke('cmds-state-get'),
  cmdsAbrirLog: () => ipcRenderer.invoke('cmds-open-log'),
  onCmdsEstado: (cb) => ipcRenderer.on('cmds-state', (_e, s) => cb(s)),
  onCmdsSalida: (cb) => ipcRenderer.on('cmds-output', (_e, lineas) => cb(lineas)),
  // CFG-INICIO
  // Configuración (archivos por equipo y scripts en segundo plano)
  cfgObtener: () => ipcRenderer.invoke('cfg-get'),
  cfgHistorial: (dev) => ipcRenderer.invoke('cfg-hist', dev),
  cfgAgregar: (dev) => ipcRenderer.invoke('cfg-add', dev),
  cfgQuitar: (dev, id) => ipcRenderer.invoke('cfg-remove', dev, id),
  cfgAbrir: (id) => ipcRenderer.invoke('cfg-open', id),
  cfgEjecutar: (dev, id) => ipcRenderer.invoke('cfg-run', dev, id),
  cfgDetener: (id) => ipcRenderer.invoke('cfg-stop', id),
  cfgAbrirLog: (id) => ipcRenderer.invoke('cfg-open-log', id),
  onCfgEstado: (cb) => ipcRenderer.on('cfg-state', (_e, s) => cb(s)),
  onCfgSalida: (cb) => ipcRenderer.on('cfg-output', (_e, d) => cb(d)),
  // CFG-FIN
  // TC-INICIO
  // Generar Test case (UUT_case)
  tcObtener: () => ipcRenderer.invoke('tc-get'),
  tcHistorial: () => ipcRenderer.invoke('tc-hist'),
  tcGuardar: (slots) => ipcRenderer.invoke('tc-save', slots),
  tcElegirRuta: () => ipcRenderer.invoke('tc-set-path'),
  tcEscanear: () => ipcRenderer.invoke('tc-scan'),
  tcCorrer: (slots, seleccion) => ipcRenderer.invoke('tc-run', slots, seleccion),
  tcDetener: () => ipcRenderer.invoke('tc-stop'),
  tcLeerArchivo: () => ipcRenderer.invoke('tc-read-file'),
  tcAbrirArchivo: () => ipcRenderer.invoke('tc-open-file'),
  tcAbrirLog: () => ipcRenderer.invoke('tc-open-log'),
  onTcEstado: (cb) => ipcRenderer.on('tc-state', (_e, s) => cb(s)),
  onTcSalida: (cb) => ipcRenderer.on('tc-output', (_e, l) => cb(l)),
  onTcSlot: (cb) => ipcRenderer.on('tc-slot', (_e, d) => cb(d)),
  onTcSlots: (cb) => ipcRenderer.on('tc-slots', (_e, d) => cb(d)),
  // TC-FIN

  // Consola telnet de cada Izumi (abre su propia ventana)
  abrirConsolaIzumi: (n) => ipcRenderer.invoke('izu:abrir', n),
  consolasIzumi: () => ipcRenderer.invoke('izu:sesiones'),
  onConsolasIzumi: (cb) => ipcRenderer.on('izumi-sesiones', (_e, s) => cb(s))
});

// Actualizaciones
contextBridge.exposeInMainWorld('actualizador', {
  version: () => ipcRenderer.invoke('app:version'),
  buscar: () => ipcRenderer.invoke('update:buscar'),
  descargar: () => ipcRenderer.invoke('update:descargar'),
  instalar: () => ipcRenderer.invoke('update:instalar'),
  alCambiar: (fn) => ipcRenderer.on('update:estado', (_e, datos) => fn(datos))
});
