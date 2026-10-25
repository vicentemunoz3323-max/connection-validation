const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sistema', {
  // Validación de conexión
  ejecutar: () => ipcRenderer.invoke('run-validation'),
  estado: () => ipcRenderer.invoke('get-estado'),
  onEstado: (cb) => ipcRenderer.on('validation-state', (_e, s) => cb(s)),
  onConsoleLog: (cb) => ipcRenderer.on('console-log', (_e, t) => cb(t)),
  // Izumis: revisión por telnet (conectada / ocupada / booteando / sin conexión)
  izumisObtener: () => ipcRenderer.invoke('izumis-get'),
  onIzumiEstado: (cb) => ipcRenderer.on('izumi-estado', (_e, d) => cb(d)),
  onIzumisReset: (cb) => ipcRenderer.on('izumis-reset', () => cb()),
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
  // Chiller monitor (script bash en segundo plano)
  chObtener: () => ipcRenderer.invoke('ch-get'),
  // Configuración del servidor (gf_provisioning.py)
  srvObtener: () => ipcRenderer.invoke('srv-get'),
  srvCorrer: (opc) => ipcRenderer.invoke('srv-run', opc),
  srvDetener: () => ipcRenderer.invoke('srv-stop'),
  srvResponder: (t) => ipcRenderer.invoke('srv-responder', t),
  srvDesmarcar: (paso) => ipcRenderer.invoke('srv-desmarcar', paso),
  srvValores: (v) => ipcRenderer.invoke('srv-valores', v),
  srvScriptLeer: () => ipcRenderer.invoke('srv-script-leer'),
  srvScriptGuardar: (t) => ipcRenderer.invoke('srv-script-guardar', t),
  srvScriptRestaurar: () => ipcRenderer.invoke('srv-script-restaurar'),
  srvAbrirLog: () => ipcRenderer.invoke('srv-abrir-log'),
  srvQuitarCred: () => ipcRenderer.invoke('srv-quitar-cred'),
  srvAbrirEstado: () => ipcRenderer.invoke('srv-abrir-estado'),
  onSrvEstado: (cb) => ipcRenderer.on('srv-estado', (_e, d) => cb(d)),
  onSrvSalida: (cb) => ipcRenderer.on('srv-salida', (_e, d) => cb(d)),
  onSrvPide: (cb) => ipcRenderer.on('srv-pide', (_e, d) => cb(d)),
  onSrvLimpiar: (cb) => ipcRenderer.on('srv-limpiar', () => cb()),
  // Llave USB con las contraseñas
  llaveEstado: () => ipcRenderer.invoke('llave-estado'),
  llaveLeer: () => ipcRenderer.invoke('llave-leer'),
  llaveUsbs: () => ipcRenderer.invoke('llave-usbs'),
  llaveCrear: (opc) => ipcRenderer.invoke('llave-crear', opc),
  onLlaveEstado: (cb) => ipcRenderer.on('llave-estado', (_e, d) => cb(d)),
  chElegir: (dev) => ipcRenderer.invoke('ch-elegir', dev),
  chCorrer: (dev) => ipcRenderer.invoke('ch-run', dev),
  chDetener: () => ipcRenderer.invoke('ch-stop'),
  chAbrirLog: (dev) => ipcRenderer.invoke('ch-open-log', dev),
  onChSalida: (cb) => ipcRenderer.on('ch-salida', (_e, d) => cb(d)),
  onChEstado: (cb) => ipcRenderer.on('ch-estado', (_e, d) => cb(d)),
  onChLimpiar: (cb) => ipcRenderer.on('ch-limpiar', (_e, d) => cb(d)),
  tcHistorial: () => ipcRenderer.invoke('tc-hist'),
  tcGuardar: (slots) => ipcRenderer.invoke('tc-save', slots),
  tcElegirRuta: () => ipcRenderer.invoke('tc-set-path'),
  tcEscanear: () => ipcRenderer.invoke('tc-scan'),
  tcCorrerScript: () => ipcRenderer.invoke('tc-script-run'),
  tcElegirScript: () => ipcRenderer.invoke('tc-script-set'),
  tcCorrer: (slots, seleccion) => ipcRenderer.invoke('tc-run', slots, seleccion),
  tcDetener: () => ipcRenderer.invoke('tc-stop'),
  tcLeerArchivo: () => ipcRenderer.invoke('tc-read-file'),
  tcEscribirArchivo: (texto) => ipcRenderer.invoke('tc-write-file', texto),
  tcAbrirArchivo: () => ipcRenderer.invoke('tc-open-file'),
  tcAbrirLog: () => ipcRenderer.invoke('tc-open-log'),
  onTcEstado: (cb) => ipcRenderer.on('tc-state', (_e, s) => cb(s)),
  onTcSalida: (cb) => ipcRenderer.on('tc-output', (_e, l) => cb(l)),
  onTcSlot: (cb) => ipcRenderer.on('tc-slot', (_e, d) => cb(d)),
  onTcSlots: (cb) => ipcRenderer.on('tc-slots', (_e, d) => cb(d)),
  // TC-FIN

  reenfocar: () => ipcRenderer.invoke('app:reenfocar'),
  // Carpeta central de logs (~/Ghostfish-Logs) y bitácora de acciones
  logsAbrir: (seccion) => ipcRenderer.invoke('bitacora-abrir', seccion),
  logsRuta: () => ipcRenderer.invoke('bitacora-ruta'),
  bitacora: (seccion, accion, detalle) => ipcRenderer.invoke('bitacora-registrar', seccion, accion, detalle),
  // Manual de usuario en PDF
  manualPdf: () => ipcRenderer.invoke('manual-pdf'),

  // Remplazar Izumi: MAC actuales leídas de /etc/dhcp/dhcpd.conf
  rzLeerMacs: () => ipcRenderer.invoke('rz-leer'),
  rzAplicar: (datos) => ipcRenderer.invoke('rz-aplicar', datos),

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
