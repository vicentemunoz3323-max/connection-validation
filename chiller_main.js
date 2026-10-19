'use strict';
/* ============================================================
   CHILLER MONITOR (proceso principal)
   - Cada chiller (con OMRON / con termopar) tiene su script bash.
   - El script se elige una vez y se recuerda.
   - Se corre en segundo plano y la salida llega a la app en vivo,
     con los colores del script (rojo = error, verde = OK, cyan = paso).
   - Los "[n/N]" del script se usan para la barra de avance.
   - Los "read -p ... presiona una tecla" no se quedan esperando:
     el script corre sin teclado (stdin vacío).
   Se carga desde main.js con:  const chiller = require('./chiller_main.js');
   ============================================================ */
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DEVS = {
  chiller_omron: 'CHILLER MONITOR CON OMRON',
  chiller_termopar: 'CHILLER MONITOR CON TERMOPAR'
};
const FLUSH_MS = 80;
const MAX_HIST = 3000;
const RX_PASO = /\[(\d+)\s*\/\s*(\d+)\]\s*(.+?)\s*(?:={2,}|$)/;
const RX_SGR = /\x1b\[([0-9;]*)m/g;
const RX_OTROS_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

let compartido = { systemdRun: async () => null, varsSesion: [] };
function configurar(opc) { compartido = { ...compartido, ...opc }; }

/* ---------- Configuración guardada ---------- */
const rutaConfig = () => path.join(app.getPath('userData'), 'chiller.json');
let cfg = null;
function cargar() {
  if (cfg) return cfg;
  try { cfg = JSON.parse(fs.readFileSync(rutaConfig(), 'utf8')); } catch (e) { cfg = {}; }
  if (!cfg.rutas || typeof cfg.rutas !== 'object') cfg.rutas = {};
  if (!cfg.ultimo || typeof cfg.ultimo !== 'object') cfg.ultimo = {};
  return cfg;
}
function guardar() {
  try {
    const tmp = rutaConfig() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, rutaConfig());
  } catch (e) { console.log('[chiller] no se pudo guardar la configuración:', e.message); }
}

// Lee los pasos "=== [1/5] Título ===" del script para mostrarlos antes de correr
function pasosDe(ruta) {
  try {
    const txt = fs.readFileSync(ruta, 'utf8');
    const pasos = [];
    for (const l of txt.split('\n')) {
      if (/^\s*#/.test(l)) continue;
      const m = l.replace(/\$\{?\w+\}?/g, '').replace(RX_OTROS_ANSI, '').replace(/\\033\[[0-9;]*m/g, '').match(RX_PASO);
      if (m && !pasos.some((p) => p.n === +m[1])) pasos.push({ n: +m[1], total: +m[2], titulo: m[3].replace(/["']+$/, '').trim() });
    }
    return pasos.sort((a, b) => a.n - b.n);
  } catch (e) { return []; }
}

/* ---------- Salida hacia la ventana ---------- */
const hist = {};            // dev -> [{t, s, h}]
let cola = [];
let timer = null;
let trabajo = null;         // { dev, inicio, proc, unidad, log, logStream, abort, color, paso, total }

function enviar(canal, datos) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(canal, datos);
}
function estado() {
  const c = cargar();
  const scripts = {};
  for (const dev of Object.keys(DEVS)) {
    const ruta = c.rutas[dev] || null;
    const existe = !!(ruta && fs.existsSync(ruta));
    scripts[dev] = { ruta, existe, pasos: existe ? pasosDe(ruta) : [] };
  }
  return {
    scripts,
    ultimo: c.ultimo,
    trabajo: trabajo ? { dev: trabajo.dev, inicio: trabajo.inicio, paso: trabajo.paso, total: trabajo.total, log: trabajo.log } : null
  };
}
function emitirEstado() { enviar('ch-estado', estado()); }

function vaciar() {
  timer = null;
  if (!cola.length) return;
  const lote = cola; cola = [];
  const porDev = {};
  for (const r of lote) (porDev[r.dev] = porDev[r.dev] || []).push({ t: r.t, s: r.s, h: r.h });
  for (const [dev, lineas] of Object.entries(porDev)) enviar('ch-salida', { dev, lineas });
}
function linea(dev, t, s) {
  const r = { t, s: String(s), h: Date.now() };
  const arr = (hist[dev] = hist[dev] || []);
  arr.push(r);
  if (arr.length > MAX_HIST) arr.splice(0, arr.length - MAX_HIST);
  if (trabajo && trabajo.logStream && trabajo.dev === dev) {
    try { trabajo.logStream.write(new Date(r.h).toISOString() + ' [' + t + '] ' + r.s + '\n'); } catch (e) {}
  }
  cola.push({ dev, ...r });
  if (!timer) timer = setTimeout(vaciar, FLUSH_MS);
}

// Convierte el texto con colores ANSI en líneas con tipo (err / ok / sys / warn / out)
const COLOR_TIPO = { 31: 'err', 91: 'err', 32: 'ok', 92: 'ok', 36: 'sys', 96: 'sys', 34: 'sys', 94: 'sys', 33: 'warn', 93: 'warn' };
function procesarLinea(t, crudo, esErr) {
  let tipo = null;
  let limpio = '';
  let ultimo = 0;
  const avanzar = (texto) => {
    if (!tipo && texto.trim()) tipo = t.color;
    limpio += texto;
  };
  RX_SGR.lastIndex = 0;
  let m;
  while ((m = RX_SGR.exec(crudo))) {
    avanzar(crudo.slice(ultimo, m.index));
    for (const cod of (m[1] || '0').split(';').map(Number)) {
      if (cod === 0 || cod === 39) t.color = null;
      else if (COLOR_TIPO[cod]) t.color = COLOR_TIPO[cod];
    }
    ultimo = RX_SGR.lastIndex;
  }
  avanzar(crudo.slice(ultimo));
  limpio = limpio.replace(RX_OTROS_ANSI, '');
  if (!tipo) tipo = t.color;
  if (/^\[sudo\] (password|contraseña)/i.test(limpio.trim())) { limpio = limpio.replace(/^\s*\[sudo\][^:]*:\s*/i, ''); if (!limpio.trim()) return; tipo = 'out'; }
  if (esErr && !tipo) tipo = 'err';
  const paso = limpio.match(RX_PASO);
  if (paso) { t.paso = +paso[1]; t.total = +paso[2]; t.tituloPaso = paso[3].trim(); emitirEstado(); }
  linea(t.dev, tipo || 'out', limpio);
}
function crearLector(t, esErr) {
  const dec = new StringDecoder('utf8');
  let resto = '';
  let timerParcial = null;
  const soltar = () => { timerParcial = null; if (resto) { procesarLinea(t, resto, esErr); resto = ''; } };
  return {
    push(buf) {
      const txt = resto + dec.write(buf);
      const partes = txt.split(/\r\n|\n|\r/);
      resto = partes.pop();
      for (const p of partes) procesarLinea(t, p, esErr);
      if (timerParcial) clearTimeout(timerParcial);
      if (resto) timerParcial = setTimeout(soltar, 400);
    },
    flush() { if (timerParcial) clearTimeout(timerParcial); resto += dec.end(); soltar(); }
  };
}

/* ---------- Correr el script ---------- */
const comillas = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function sello() {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}

async function correr(dev) {
  if (!DEVS[dev]) return { ok: false, error: 'Equipo desconocido' };
  if (trabajo) return { ok: false, error: 'Ya hay un script corriendo en ' + DEVS[trabajo.dev] };
  const ruta = cargar().rutas[dev];
  if (!ruta || !fs.existsSync(ruta)) return { ok: false, error: 'Primero selecciona el script' };

  const dir = path.join(app.getPath('userData'), 'chiller', dev);      // ahí caen los scp con "."
  const dirLogs = path.join(app.getPath('userData'), 'logs', 'chiller');
  try { fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(dirLogs, { recursive: true }); } catch (e) {}
  const log = path.join(dirLogs, dev + '_' + sello() + '.log');
  let logStream = null;
  try { logStream = fs.createWriteStream(log, { flags: 'a' }); logStream.on('error', () => {}); } catch (e) {}

  const t = { dev, inicio: Date.now(), proc: null, unidad: null, log, logStream, abort: false, color: null, paso: 0, total: pasosDe(ruta).length ? pasosDe(ruta)[0].total : 0 };
  trabajo = t;
  hist[dev] = [];
  enviar('ch-limpiar', { dev });
  linea(dev, 'sys', '▶ ' + path.basename(ruta) + ' · ' + new Date().toLocaleString('es'));
  emitirEstado();

  const env = { ...process.env, TERM: 'dumb', LANG: process.env.LANG || 'C.UTF-8' };
  let cmd, args;
  const sr = await compartido.systemdRun();          // la app tiene "no new privileges": se corre fuera con systemd-run
  if (sr) {
    t.unidad = 'cv-chiller-' + Date.now();
    const vars = [];
    for (const k of compartido.varsSesion || []) if (process.env[k]) vars.push('--setenv=' + k + '=' + process.env[k]);
    cmd = sr;
    args = ['--user', '--pipe', '--quiet', '--wait', '--collect', '--unit=' + t.unidad, '--working-directory=' + dir,
      '-p', 'KillMode=process', ...vars, '--setenv=TERM=dumb', '--', '/bin/bash', ruta];
    linea(dev, 'sys', '(corre fuera de la app con systemd-run para que sudo funcione)');
  } else {
    cmd = '/bin/bash';
    args = [ruta];
  }

  const codigo = await new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { linea(dev, 'err', 'No se pudo iniciar: ' + e.message); return resolve(-1); }
    t.proc = p;
    const out = crearLector(t, false), err = crearLector(t, true);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    let listo = false;
    p.on('error', (e) => { if (listo) return; listo = true; out.flush(); err.flush(); linea(dev, 'err', 'Error: ' + e.message); resolve(-1); });
    p.on('close', (c) => { if (listo) return; listo = true; out.flush(); err.flush(); resolve(c === null ? -1 : c); });
  });

  const seg = Math.round((Date.now() - t.inicio) / 1000);
  const dur = Math.floor(seg / 60) + ':' + String(seg % 60).padStart(2, '0');
  if (t.abort) linea(dev, 'warn', '■ Detenido por el usuario · ' + dur);
  else if (codigo === 0) linea(dev, 'ok', '✓ Terminó sin errores (código 0) · ' + dur);
  else linea(dev, 'err', '✕ El script terminó con código ' + codigo + ' · ' + dur);
  vaciar();
  try { if (logStream) logStream.end(); } catch (e) {}

  const c = cargar();
  c.ultimo[dev] = { codigo: t.abort ? null : codigo, detenido: !!t.abort, fin: Date.now(), paso: t.paso, total: t.total, tituloPaso: t.tituloPaso || '', log };
  guardar();
  trabajo = null;
  emitirEstado();
  return { ok: codigo === 0, codigo };
}

function detener() {
  const t = trabajo;
  if (!t) return false;
  t.abort = true;
  if (t.unidad) {
    try { spawn('systemctl', ['--user', 'kill', '--signal=SIGTERM', t.unidad], { stdio: 'ignore' }).on('error', () => {}); } catch (e) {}
  }
  const p = t.proc;
  if (p && p.pid) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { try { p.kill('SIGTERM'); } catch (e2) {} }
    setTimeout(() => {
      if (trabajo !== t) return;
      if (t.unidad) { try { spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', t.unidad], { stdio: 'ignore' }).on('error', () => {}); } catch (e) {} }
      try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) {} }
    }, 3000);
  }
  return true;
}

/* ---------- IPC ---------- */
ipcMain.handle('ch-get', () => ({ ...estado(), hist }));
ipcMain.handle('ch-elegir', async (e, dev) => {
  if (!DEVS[dev]) return { ok: false };
  if (trabajo && trabajo.dev === dev) return { ok: false, error: 'Espera a que termine el script' };
  const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
  const actual = cargar().rutas[dev];
  const r = await dialog.showOpenDialog(win, {
    title: 'Script de ' + DEVS[dev],
    defaultPath: actual ? path.dirname(actual) : app.getPath('home'),
    properties: ['openFile'],
    filters: [{ name: 'Scripts bash', extensions: ['sh', 'bash'] }, { name: 'Todos los archivos', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: true, cambio: false };
  cargar().rutas[dev] = r.filePaths[0];
  guardar();
  emitirEstado();
  return { ok: true, cambio: true };
});
ipcMain.handle('ch-run', (_e, dev) => {
  if (trabajo) return { ok: false, error: 'Ya hay un script corriendo en ' + DEVS[trabajo.dev] };
  correr(dev);
  return { ok: true };
});
ipcMain.handle('ch-stop', () => detener());
ipcMain.handle('ch-open-log', (_e, dev) => {
  const u = cargar().ultimo[dev];
  const p = (trabajo && trabajo.dev === dev && trabajo.log) || (u && u.log);
  if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return true; }
  const dir = path.join(app.getPath('userData'), 'logs', 'chiller');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  shell.openPath(dir);
  return true;
});

module.exports = { configurar, detener, ocupado: () => !!trabajo };
