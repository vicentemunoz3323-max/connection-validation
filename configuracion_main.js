'use strict';
/* ============================================================
   CONFIGURACIÓN (proceso principal)
   - Guarda, por equipo, la lista de archivos cargados.
   - Los .py se pueden ejecutar en segundo plano (switch ON/OFF).
   - Cada ejecución genera un log y manda toda su actividad a la ventana.
   Se carga desde main.js con:  require('./configuracion_main.js');
   ============================================================ */
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DISPOSITIVOS = [
  { id: 'server', nombre: 'SERVER' },
  { id: 'juniper', nombre: 'JUNIPER' },
  { id: 'tros', nombre: 'TROSS' },
  { id: 'zpe', nombre: 'ZPE' },
  { id: 'daq', nombre: 'DAQ' },
  { id: 'omron', nombre: 'SENSOR OMRON' },
  { id: 'chiller_omron', nombre: 'CHILLER MONITOR CON OMRON' },
  { id: 'chiller_termopar', nombre: 'CHILLER MONITOR CON TERMOPAR' }
];
const IDS = new Set(DISPOSITIVOS.map((d) => d.id));

// Tipos de archivo que se pueden EJECUTAR (el resto solo se guarda y se abre).
// Para permitir bash en el futuro: agregar  '.sh': 'bash'  y manejarlo en iniciar().
const EJECUTABLES = { '.py': 'python' };

const FLUSH_MS = 80;            // cada cuánto se manda un lote de líneas a la pantalla
const IDLE_PARCIAL_MS = 400;    // una línea incompleta se muestra tras este tiempo
const MAX_HIST = 3000;          // líneas que se recuerdan por equipo (el log guarda todo)
const MAX_LARGO_LINEA = 4000;   // solo se recorta en pantalla, no en el log
const REGEX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/* ---------- Almacén de archivos cargados ---------- */
const rutaConfig = () => path.join(app.getPath('userData'), 'configuracion.json');
let datos = null;

function cargar() {
  if (datos) return datos;
  datos = {};
  try {
    const j = JSON.parse(fs.readFileSync(rutaConfig(), 'utf8'));
    if (j && typeof j === 'object') datos = j;
  } catch (e) {}
  for (const d of DISPOSITIVOS) if (!Array.isArray(datos[d.id])) datos[d.id] = [];
  return datos;
}

function guardar() {
  try {
    fs.mkdirSync(path.dirname(rutaConfig()), { recursive: true });
    const tmp = rutaConfig() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
    fs.renameSync(tmp, rutaConfig());
  } catch (e) {
    console.log('[config] no se pudo guardar:', e.message);
  }
}

function buscarArchivo(fileId) {
  const d = cargar();
  for (const disp of DISPOSITIVOS) {
    const a = d[disp.id].find((x) => x.id === fileId);
    if (a) return { devId: disp.id, arch: a };
  }
  return null;
}

/* ---------- Estado y envío a la ventana ---------- */
const corriendo = new Map();   // fileId -> { devId, nombre, inicio, log, logStream, proc, abortado, terminado }
const hist = {};               // devId -> [líneas recientes]
const cola = {};               // devId -> [líneas pendientes de enviar]
let timer = null;
let seq = 0;

function enviar(canal, datosEnvio) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(canal, datosEnvio);
  }
}

function snapshot() {
  const d = cargar();
  const dispositivos = {};
  for (const disp of DISPOSITIVOS) {
    dispositivos[disp.id] = d[disp.id].map((a) => {
      const run = corriendo.get(a.id);
      return {
        id: a.id, nombre: a.nombre, ruta: a.ruta, ext: a.ext, tam: a.tam, agregado: a.agregado,
        ejecutable: !!EJECUTABLES[a.ext],
        existe: fs.existsSync(a.ruta),
        ultimo: a.ultimo || null,
        corriendo: run ? { inicio: run.inicio, log: run.log } : null
      };
    });
  }
  return { dispositivos };
}

function emitirEstado() { enviar('cfg-state', snapshot()); }

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const devId of Object.keys(cola)) {
    if (cola[devId].length) {
      enviar('cfg-output', { dev: devId, lineas: cola[devId] });
      cola[devId] = [];
    }
  }
}

const dos = (n) => String(n).padStart(2, '0');
const horaTxt = (ms) => { const d = new Date(ms); return dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds()); };
const fechaTxt = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' + horaTxt(ms); };

// tipo: 'out' (salida normal), 'err' (errores) o 'sys' (lo que hace la app)
function linea(devId, fileId, nombre, tipo, texto) {
  const ahora = Date.now();
  const reg = {
    i: ++seq, t: tipo, h: ahora, f: fileId, n: nombre,
    s: texto.length > MAX_LARGO_LINEA ? texto.slice(0, MAX_LARGO_LINEA) + ' …[línea recortada en pantalla]' : texto
  };
  (hist[devId] = hist[devId] || []).push(reg);
  if (hist[devId].length > MAX_HIST + 500) hist[devId].splice(0, hist[devId].length - MAX_HIST);
  (cola[devId] = cola[devId] || []).push(reg);

  const run = corriendo.get(fileId);
  if (run && run.logStream) {
    run.logStream.write('[' + fechaTxt(ahora) + '] ' + (tipo === 'err' ? '[ERR] ' : tipo === 'sys' ? '>>> ' : '') + texto + '\n');
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

/* ---------- Lector de líneas del proceso ---------- */
function crearLector(tipo, emitir) {
  const decoder = new StringDecoder('utf8');
  let resto = '';
  let idle = null;
  const limpiar = (t) => t.replace(REGEX_ANSI, '');
  const vaciar = () => {
    const t = resto.replace(/\r$/, '');
    resto = '';
    if (t.length) emitir(tipo, limpiar(t));
  };
  return {
    push(buf) {
      if (idle) { clearTimeout(idle); idle = null; }
      let texto = resto + decoder.write(buf);
      let retenido = '';
      if (texto.endsWith('\r')) { retenido = '\r'; texto = texto.slice(0, -1); }
      const partes = texto.split(/\r\n|\n|\r/);
      resto = partes.pop() + retenido;
      for (const l of partes) emitir(tipo, limpiar(l));
      if (resto.length) idle = setTimeout(vaciar, IDLE_PARCIAL_MS);
    },
    flush() {
      if (idle) { clearTimeout(idle); idle = null; }
      const fin = decoder.end();
      if (fin) resto += fin;
      vaciar();
    }
  };
}

// Devuelve el temporizador del SIGKILL de respaldo (para cancelarlo si el proceso ya murió)
function matarArbol(proc) {
  if (!proc || !proc.pid) return null;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      return null;
    }
    process.kill(-proc.pid, 'SIGTERM');
    return setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) {} }, 3000);
  } catch (e) {
    try { proc.kill(); } catch (e2) {}
    return null;
  }
}

/* ---------- Ejecución en segundo plano ---------- */
function finalizar(run, codigo, motivo) {
  if (run.terminado) return;
  run.terminado = true;
  if (run.killTimer) { clearTimeout(run.killTimer); run.killTimer = null; }
  const seg = ((Date.now() - run.inicio) / 1000).toFixed(1);
  const estado = run.abortado ? 'detenido' : (codigo === 0 ? 'ok' : 'fallo');

  if (motivo) linea(run.devId, run.fileId, run.nombre, 'err', motivo);
  if (estado === 'ok') linea(run.devId, run.fileId, run.nombre, 'sys', '✓ Terminó correctamente (código 0) · ' + seg + ' s');
  else if (estado === 'detenido') linea(run.devId, run.fileId, run.nombre, 'sys', '■ Detenido por el usuario · ' + seg + ' s');
  else linea(run.devId, run.fileId, run.nombre, 'sys', '✕ Terminó con error (código ' + codigo + ') · ' + seg + ' s');
  linea(run.devId, run.fileId, run.nombre, 'sys', 'Log guardado en: ' + run.log);

  if (run.logStream) { run.logStream.end(); run.logStream = null; }
  const enc = buscarArchivo(run.fileId);
  if (enc) {
    enc.arch.ultimo = { fin: Date.now(), codigo, estado, log: run.log, segundos: Number(seg) };
    guardar();
  }
  corriendo.delete(run.fileId);
  flush();
  emitirEstado();
}

function iniciar(devId, fileId) {
  const enc = buscarArchivo(fileId);
  if (!enc || enc.devId !== devId) return { ok: false, error: 'El archivo no está en la configuración.' };
  const arch = enc.arch;
  if (!EJECUTABLES[arch.ext]) return { ok: false, error: 'Este tipo de archivo no se ejecuta.' };
  if (corriendo.has(fileId)) return { ok: false, error: 'Ya se está ejecutando.' };
  if (!fs.existsSync(arch.ruta)) {
    linea(devId, fileId, arch.nombre, 'err', 'El archivo ya no existe: ' + arch.ruta);
    flush();
    emitirEstado();
    return { ok: false, error: 'El archivo ya no existe en su ubicación.' };
  }

  // Log de esta ejecución
  const inicio = Date.now();
  let logPath = null;
  let logStream = null;
  try {
    const dir = path.join(app.getPath('userData'), 'logs', 'configuracion');
    fs.mkdirSync(dir, { recursive: true });
    const sello = fechaTxt(inicio).replace(/[: ]/g, '-');
    const seguro = arch.nombre.replace(/[^\w.\-]+/g, '_');
    logPath = path.join(dir, devId + '_' + seguro + '_' + sello + '.log');
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => {});   // un fallo de disco no debe tumbar la app
    logStream.write('# ' + arch.nombre + ' · equipo ' + devId.toUpperCase() + ' · ' + fechaTxt(inicio) + '\n# ' + arch.ruta + '\n\n');
  } catch (e) {
    logStream = null;
  }

  const run = { devId, fileId, nombre: arch.nombre, inicio, log: logPath, logStream, proc: null, abortado: false, terminado: false };
  corriendo.set(fileId, run);
  linea(devId, fileId, arch.nombre, 'sys', '▶ Iniciando ' + arch.nombre);
  linea(devId, fileId, arch.nombre, 'sys', 'Archivo: ' + arch.ruta);
  linea(devId, fileId, arch.nombre, 'sys', 'Carpeta de trabajo: ' + path.dirname(arch.ruta));
  if (logPath) linea(devId, fileId, arch.nombre, 'sys', 'Log: ' + logPath);

  const interpretes = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  const emitir = (tipo, texto) => linea(devId, fileId, arch.nombre, tipo, texto);

  const arrancar = (i) => {
    if (run.abortado) return finalizar(run, -1);
    if (i >= interpretes.length) {
      return finalizar(run, -1, 'No se encontró Python instalado (se probó: ' + interpretes.join(', ') + ').');
    }
    let manejado = false;
    let proc;
    try {
      proc = spawn(interpretes[i], ['-u', arch.ruta], {
        cwd: path.dirname(arch.ruta),
        detached: process.platform !== 'win32',   // grupo propio para poder detener todo el árbol
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' }
      });
    } catch (e) {
      return arrancar(i + 1);
    }
    run.proc = proc;
    const lectorOut = crearLector('out', emitir);
    const lectorErr = crearLector('err', emitir);
    proc.stdout.on('data', (d) => lectorOut.push(d));
    proc.stderr.on('data', (d) => lectorErr.push(d));
    proc.on('spawn', () => emitir('sys', 'Intérprete: ' + interpretes[i] + ' · PID ' + proc.pid));
    proc.on('error', (e) => {
      if (manejado) return;
      manejado = true;
      lectorOut.flush(); lectorErr.flush();
      if (e.code === 'ENOENT') arrancar(i + 1);
      else finalizar(run, -1, 'No se pudo iniciar: ' + e.message);
    });
    proc.on('close', (code) => {
      if (manejado) return;
      manejado = true;
      lectorOut.flush(); lectorErr.flush();
      finalizar(run, code === null ? -1 : code);
    });
  };

  emitirEstado();
  arrancar(0);
  return { ok: true };
}

function detener(fileId) {
  const run = corriendo.get(fileId);
  if (!run) return { ok: false };
  run.abortado = true;
  linea(run.devId, run.fileId, run.nombre, 'sys', '… Deteniendo ' + run.nombre);
  run.killTimer = matarArbol(run.proc);
  return { ok: true };
}

/* ---------- Canales con la ventana ---------- */
ipcMain.handle('cfg-get', () => ({ lista: DISPOSITIVOS, ...snapshot() }));

ipcMain.handle('cfg-hist', (_e, devId) => (IDS.has(devId) ? (hist[devId] || []) : []));

ipcMain.handle('cfg-add', async (e, devId) => {
  if (!IDS.has(devId)) return { ok: false, error: 'Equipo no válido.' };
  const win = BrowserWindow.fromWebContents(e.sender) || undefined;
  const r = await dialog.showOpenDialog(win, {
    title: 'Cargar archivos en ' + DISPOSITIVOS.find((d) => d.id === devId).nombre,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Todos los archivos', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: true, agregados: 0 };

  const lista = cargar()[devId];
  let agregados = 0;
  for (const ruta of r.filePaths) {
    if (lista.some((a) => a.ruta === ruta)) {
      linea(devId, '', '', 'sys', 'Ya estaba cargado: ' + path.basename(ruta));
      continue;
    }
    let tam = 0;
    try { tam = fs.statSync(ruta).size; } catch (err) {}
    const ext = path.extname(ruta).toLowerCase();
    lista.push({ id: crypto.randomUUID(), nombre: path.basename(ruta), ruta, ext, tam, agregado: Date.now(), ultimo: null });
    agregados++;
    linea(devId, '', '', 'sys', '+ Archivo cargado: ' + path.basename(ruta) + (EJECUTABLES[ext] ? ' (se puede ejecutar)' : ' (solo documento)'));
  }
  if (agregados) guardar();
  flush();
  emitirEstado();
  return { ok: true, agregados };
});

ipcMain.handle('cfg-remove', (_e, devId, fileId) => {
  const enc = buscarArchivo(fileId);
  if (!enc || enc.devId !== devId) return { ok: false };
  if (corriendo.has(fileId)) detener(fileId);
  const lista = cargar()[devId];
  lista.splice(lista.findIndex((a) => a.id === fileId), 1);
  guardar();
  linea(devId, '', '', 'sys', '− Archivo quitado de la lista: ' + enc.arch.nombre);
  flush();
  emitirEstado();
  return { ok: true };
});

ipcMain.handle('cfg-open', async (_e, fileId) => {
  const enc = buscarArchivo(fileId);
  if (!enc) return { ok: false, error: 'Archivo no encontrado.' };
  if (!fs.existsSync(enc.arch.ruta)) return { ok: false, error: 'El archivo ya no existe en su ubicación.' };
  const err = await shell.openPath(enc.arch.ruta);   // '' si se abrió bien
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('cfg-run', (_e, devId, fileId) => iniciar(devId, fileId));
ipcMain.handle('cfg-stop', (_e, fileId) => detener(fileId));

ipcMain.handle('cfg-open-log', (_e, fileId) => {
  const dir = path.join(app.getPath('userData'), 'logs', 'configuracion');
  const run = fileId ? corriendo.get(fileId) : null;
  const enc = fileId ? buscarArchivo(fileId) : null;
  const log = (run && run.log) || (enc && enc.arch.ultimo && enc.arch.ultimo.log);
  if (log && fs.existsSync(log)) {
    shell.showItemInFolder(log);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  }
  return true;
});

app.on('before-quit', () => {
  for (const run of corriendo.values()) { run.abortado = true; matarArbol(run.proc); }
});

console.log('[config] módulo de configuración cargado');
