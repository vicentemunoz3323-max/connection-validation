'use strict';
/* ============================================================
   GENERAR TEST CASE (proceso principal)
   Port del script de terminal "UUT_case interfaz":
   - Escanea los 16 slots (ping + telnet al ZPE) y obtiene parte y serial.
   - Genera / lee / edita el archivo UUT_case.
   - Corre todo el UUT_case o solo slots elegidos (comandos unidos con &&).
   - Muestra el contenido del archivo generado.
   Se carga desde main.js con:  require('./testcase_main.js');
   ============================================================ */
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

/* ---------- Valores del script original (edítalos aquí si cambian) ---------- */
const CONFIG = {
  NOMBRE_ARCHIVO: 'UUT_case',
  RUTA_BASE: '~/viper-test/opentest/tools/ot_regression.py',
  ZPE_IP: '10.0.0.253',
  ZPE_PUERTO_BASE: 7000,                       // el slot N se abre en el puerto 7000 + N
  ipSlot: (n) => '10.0.0.' + n,                // IP de cada slot
  LOGIN_ZPE: 'root',
  BMC_SSH: 'ssh root@fe80::21a:11ff:fe16:fead%gbmcbr',
  BMC_PROMPT_PASSWORD: "root@fe80::21a:11ff:fe16:fead%gbmcbr's password: ",
  BMC_PASSWORD: '0penBmc',
  COMANDO_EEPROM: 'hexdump -C -n256 /sys/bus/i2c/drivers/at24/150-0050/eeprom',
  PING_VENTANA_MS: 60000,                      // cuánto se insiste con el ping por slot
  SCAN_CONCURRENCIA: 4                         // slots que se escanean a la vez (1 = uno por uno, como el original)
};
module.exports = { CONFIG };

const NUM_SLOTS = 16;
const PATRON_VALOR = /^[A-Za-z0-9._\-]+$/;     // parte y serial solo pueden llevar estos caracteres (van a un comando bash)
const FLUSH_MS = 80;
const IDLE_PARCIAL_MS = 400;
const MAX_HIST = 3000;
const MAX_LARGO_LINEA = 4000;
const REGEX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dos = (n) => String(n).padStart(2, '0');
const horaTxt = (ms) => { const d = new Date(ms); return dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds()); };
const fechaTxt = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' + horaTxt(ms); };

/* ---------- Ruta del archivo UUT_case ---------- */
const rutaCfg = () => path.join(app.getPath('userData'), 'testcase.json');
let rutaUUT = null;

function obtenerRuta() {
  if (rutaUUT) return rutaUUT;
  try {
    const j = JSON.parse(fs.readFileSync(rutaCfg(), 'utf8'));
    if (j && typeof j.ruta === 'string' && j.ruta) { rutaUUT = j.ruta; return rutaUUT; }
  } catch (e) {}
  rutaUUT = path.join(os.homedir(), CONFIG.NOMBRE_ARCHIVO);
  return rutaUUT;
}
function guardarRutaCfg(r) {
  rutaUUT = r;
  try {
    fs.mkdirSync(path.dirname(rutaCfg()), { recursive: true });
    fs.writeFileSync(rutaCfg(), JSON.stringify({ ruta: r }));
  } catch (e) {}
}

/* ---------- Salida hacia la ventana ---------- */
let trabajo = null;     // { tipo, inicio, total, hechos, abort, proc, log, logStream, killTimer }
const hist = [];
let cola = [];
let timer = null;
let seq = 0;
let ultimoLog = null;

function enviar(canal, datos) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(canal, datos);
}
function estadoPublico() {
  return {
    ruta: obtenerRuta(),
    existe: fs.existsSync(obtenerRuta()),
    job: trabajo ? { tipo: trabajo.tipo, inicio: trabajo.inicio, total: trabajo.total, hechos: trabajo.hechos, log: trabajo.log } : null
  };
}
function emitirEstado() { enviar('tc-state', estadoPublico()); }

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!cola.length) return;
  const lote = cola; cola = [];
  enviar('tc-output', lote);
}
function linea(tipo, texto) {
  const ahora = Date.now();
  const reg = { i: ++seq, t: tipo, h: ahora, s: texto.length > MAX_LARGO_LINEA ? texto.slice(0, MAX_LARGO_LINEA) + ' …[línea recortada en pantalla]' : texto };
  hist.push(reg);
  if (hist.length > MAX_HIST + 500) hist.splice(0, hist.length - MAX_HIST);
  cola.push(reg);
  if (trabajo && trabajo.logStream) {
    trabajo.logStream.write('[' + fechaTxt(ahora) + '] ' + (tipo === 'err' ? '[ERR] ' : tipo === 'sys' ? '>>> ' : '') + texto + '\n');
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

function crearLector(tipo) {
  const decoder = new StringDecoder('utf8');
  let resto = '';
  let idle = null;
  const limpiar = (t) => t.replace(REGEX_ANSI, '');
  const vaciar = () => { const t = resto.replace(/\r$/, ''); resto = ''; if (t.length) linea(tipo, limpiar(t)); };
  return {
    push(buf) {
      if (idle) { clearTimeout(idle); idle = null; }
      let texto = resto + decoder.write(buf);
      let ret = '';
      if (texto.endsWith('\r')) { ret = '\r'; texto = texto.slice(0, -1); }
      const partes = texto.split(/\r\n|\n|\r/);
      resto = partes.pop() + ret;
      for (const l of partes) linea(tipo, limpiar(l));
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

function matarArbol(proc) {
  if (!proc || !proc.pid) return null;
  try {
    if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); return null; }
    process.kill(-proc.pid, 'SIGTERM');
    return setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) {} }, 3000);
  } catch (e) {
    try { proc.kill(); } catch (e2) {}
    return null;
  }
}

/* ---------- Trabajos (uno a la vez) ---------- */
function abrirTrabajo(tipo, total) {
  if (trabajo) return null;
  const inicio = Date.now();
  let log = null, logStream = null;
  try {
    const dir = path.join(app.getPath('userData'), 'logs', 'testcase');
    fs.mkdirSync(dir, { recursive: true });
    log = path.join(dir, tipo + '_' + fechaTxt(inicio).replace(/[: ]/g, '-') + '.log');
    logStream = fs.createWriteStream(log, { flags: 'a' });
    logStream.on('error', () => {});   // un fallo de disco no debe tumbar la app
    logStream.write('# Generar Test case · ' + tipo + ' · ' + fechaTxt(inicio) + '\n\n');
  } catch (e) { logStream = null; }
  trabajo = { tipo, inicio, total, hechos: 0, abort: false, proc: null, log, logStream, killTimer: null };
  ultimoLog = log;
  emitirEstado();
  return trabajo;
}
function cerrarTrabajo() {
  if (!trabajo) return;
  if (trabajo.killTimer) clearTimeout(trabajo.killTimer);
  if (trabajo.log) linea('sys', 'Log guardado en: ' + trabajo.log);   // antes de cerrar el archivo
  if (trabajo.logStream) { trabajo.logStream.write('\n# fin · ' + fechaTxt(Date.now()) + '\n'); trabajo.logStream.end(); trabajo.logStream = null; }
  trabajo = null;
  flush();
  emitirEstado();
}
const ocupado = () => (trabajo ? { ok: false, error: 'Ya hay un trabajo en curso (' + trabajo.tipo + '). Espera o presiona Detener.' } : null);

async function pool(items, limite, fn) {
  let i = 0;
  const trabajadores = Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, async () => {
    while (i < items.length && !(trabajo && trabajo.abort)) await fn(items[i++]);
  });
  await Promise.all(trabajadores);
}

/* ---------- Archivo UUT_case ---------- */
const comandoSlot = (n, s) => CONFIG.RUTA_BASE + ' ' + n + ' ' + (s.parte || 'CORRIJA_PARTE') + ' ' + (s.serial || 'CORRIJA_SERIAL') + ' 0 10';

function normalizarSlots(entrada) {
  const slots = Array.from({ length: NUM_SLOTS }, () => ({ parte: '', serial: '' }));
  if (Array.isArray(entrada)) {
    for (let i = 0; i < NUM_SLOTS; i++) {
      const s = entrada[i] || {};
      const parte = String(s.parte == null ? '' : s.parte).trim();
      const serial = String(s.serial == null ? '' : s.serial).trim();
      if (parte && !PATRON_VALOR.test(parte)) return { ok: false, error: 'Slot ' + (i + 1) + ': el número de parte tiene caracteres no permitidos (solo letras, números, punto, guion y guion bajo).' };
      if (serial && !PATRON_VALOR.test(serial)) return { ok: false, error: 'Slot ' + (i + 1) + ': el serial tiene caracteres no permitidos (solo letras, números, punto, guion y guion bajo).' };
      slots[i] = { parte, serial };
    }
  }
  return { ok: true, slots };
}

function escribirArchivo(slots) {
  const ruta = obtenerRuta();
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const lineas = slots.map((s, i) => comandoSlot(i + 1, s));
  fs.writeFileSync(ruta, '#!/bin/bash\n\n' + lineas.join(' &&\n') + '\n', 'utf8');
  fs.chmodSync(ruta, 0o755);
  return ruta;
}

function leerArchivo() {
  const slots = Array.from({ length: NUM_SLOTS }, () => ({ parte: '', serial: '' }));
  const ruta = obtenerRuta();
  if (!fs.existsSync(ruta)) return { existe: false, slots };
  const patron = new RegExp(escRe(CONFIG.RUTA_BASE) + '\\s+(\\d+)\\s+(\\S+)\\s+(\\S+)');
  for (const l of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = l.match(patron);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < NUM_SLOTS) {
        slots[idx].parte = m[2] === 'CORRIJA_PARTE' ? '' : m[2];
        slots[idx].serial = m[3] === 'CORRIJA_SERIAL' ? '' : m[3];
      }
    }
  }
  return { existe: true, slots };
}

/* ---------- Ping ---------- */
function pingUnaVez(ip, abortCheck) {
  return new Promise((resolve) => {
    const args = process.platform === 'win32' ? ['-n', '1', '-w', '1000', ip]
      : process.platform === 'darwin' ? ['-c', '1', '-W', '1000', ip]
      : ['-c', '1', '-W', '1', ip];
    let fin = false;
    const listo = (v) => { if (!fin) { fin = true; clearTimeout(t); resolve(v); } };
    let p;
    try { p = spawn('ping', args, { windowsHide: true, stdio: 'ignore' }); } catch (e) { return resolve(false); }
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} listo(false); }, 4000);
    p.on('error', () => listo(false));
    p.on('close', (c) => listo(c === 0));
  });
}
async function pingUnidad(n) {
  const ip = CONFIG.ipSlot(n);
  const fin = Date.now() + CONFIG.PING_VENTANA_MS;
  while (Date.now() < fin) {
    if (trabajo && trabajo.abort) return false;
    const t0 = Date.now();
    if (await pingUnaVez(ip)) return true;
    const resto = 1000 - (Date.now() - t0);
    if (resto > 0) await esperar(resto);
  }
  return false;
}

/* ---------- Telnet mínimo (con negociación IAC, como telnetlib) ---------- */
function abrirTelnet(host, puerto, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: puerto });
    const s = { buf: '', cerrado: false, espera: null, sock };
    let modo = 'dato', cmd = 0, bytes = [];
    const dec = new StringDecoder('utf8');
    const volcar = () => {
      if (bytes.length) { s.buf += dec.write(Buffer.from(bytes)); bytes = []; }
      if (s.espera) s.espera.revisar();
    };
    sock.setTimeout(timeoutMs, () => { if (!s.conectado) { sock.destroy(); reject(new Error('timeout de conexión')); } });
    sock.on('connect', () => { s.conectado = true; sock.setTimeout(0); resolve(s); });
    sock.on('error', (e) => { if (!s.conectado) reject(e); s.cerrado = true; if (s.espera) s.espera.revisar(); });
    sock.on('close', () => { s.cerrado = true; if (s.espera) s.espera.revisar(); });
    sock.on('data', (d) => {
      for (const b of d) {
        if (modo === 'dato') { if (b === 255) modo = 'iac'; else bytes.push(b); }
        else if (modo === 'iac') {
          if (b === 255) { bytes.push(255); modo = 'dato'; }
          else if (b >= 251 && b <= 254) { cmd = b; modo = 'opcion'; }
          else if (b === 250) modo = 'sb';
          else modo = 'dato';
        } else if (modo === 'opcion') {
          if (cmd === 253) sock.write(Buffer.from([255, 252, b]));       // DO  -> WONT
          else if (cmd === 251) sock.write(Buffer.from([255, 254, b]));  // WILL -> DONT
          modo = 'dato';
        } else if (modo === 'sb') { if (b === 255) modo = 'sbiac'; }
        else if (modo === 'sbiac') modo = b === 240 ? 'dato' : 'sb';
      }
      volcar();
    });
    s.escribir = (t) => { try { sock.write(t); } catch (e) {} };
    s.cerrar = () => { try { sock.destroy(); } catch (e) {} };
    // Igual que telnetlib.read_until: devuelve lo leído hasta el texto esperado, o todo lo disponible al agotar el tiempo
    s.leerHasta = (texto, ms) => new Promise((res) => {
      let hecho = false;
      const fin = (r) => { if (hecho) return; hecho = true; clearTimeout(t); s.espera = null; res(r); };
      const revisar = () => {
        const i = s.buf.indexOf(texto);
        if (i >= 0) { const r = s.buf.slice(0, i + texto.length); s.buf = s.buf.slice(i + texto.length); fin(r); }
        else if (s.cerrado) { const r = s.buf; s.buf = ''; fin(r); }
      };
      const t = setTimeout(() => { const r = s.buf; s.buf = ''; fin(r); }, ms);
      s.espera = { revisar };
      revisar();
    });
  });
}

async function obtenerDatosHardware(n) {
  let tn = null;
  try {
    tn = await abrirTelnet(CONFIG.ZPE_IP, CONFIG.ZPE_PUERTO_BASE + n, 5000);
    tn.escribir('\n');
    await tn.leerHasta('(none) login: ', 3000);
    tn.escribir(CONFIG.LOGIN_ZPE + '\n');
    await tn.leerHasta('(none):~# ', 3000);
    tn.escribir(CONFIG.BMC_SSH + '\n');
    await tn.leerHasta(CONFIG.BMC_PROMPT_PASSWORD, 5000);
    tn.escribir(CONFIG.BMC_PASSWORD + '\n');
    await tn.leerHasta('root@ghostlite:~# ', 5000);
    tn.escribir(CONFIG.COMANDO_EEPROM + '\n');
    const respuesta = await tn.leerHasta('root@ghostlite:~# ', 5000);
    tn.escribir('exit\n');
    await tn.leerHasta('(none):~# ', 2000);
    tn.escribir('exit\n');
    const serialM = respuesta.match(/\bFLG\d{4}-\d{5}\b/);
    const parteM = respuesta.match(/\b(1227014|1231778)\b/) || respuesta.match(/\b\d{7}\b/);
    const serial = serialM ? serialM[0] : '';
    const parte = parteM ? parteM[0] : '';
    if (serial || parte) return { parte, serial };
  } catch (e) {
    /* sin conexión: se reporta como sin datos */
  } finally {
    if (tn) tn.cerrar();
  }
  return { parte: '', serial: '' };
}

/* ---------- Escaneo automático ---------- */
async function escanear() {
  const t = abrirTrabajo('escaneo', NUM_SLOTS);
  if (!t) return ocupado();
  linea('sys', '--- Generando ' + CONFIG.NOMBRE_ARCHIVO + ' automáticamente ---');
  const slots = Array.from({ length: NUM_SLOTS }, () => ({ parte: '', serial: '' }));
  const nums = Array.from({ length: NUM_SLOTS }, (_, i) => i + 1);
  try {
    await pool(nums, CONFIG.SCAN_CONCURRENCIA, async (n) => {
      const nn = dos(n);
      enviar('tc-slot', { n, estado: 'verificando', msg: 'Verificando…' });
      let res;
      if (await pingUnidad(n)) {
        if (t.abort) return;
        const d = await obtenerDatosHardware(n);
        if (d.parte || d.serial) {
          slots[n - 1] = d;
          res = { n, estado: 'ok', msg: 'SUCCESS', parte: d.parte, serial: d.serial };
          linea('out', 'Slot ' + nn + ': SUCCESS -> Parte: ' + d.parte + ', Serial: ' + d.serial);
        } else {
          res = { n, estado: 'fail', msg: 'Responde, sin datos' };
          linea('err', 'Slot ' + nn + ': FAIL -> Responde pero no se extrajeron datos.');
        }
      } else {
        if (t.abort) return;
        res = { n, estado: 'fail', msg: 'Sin respuesta' };
        linea('err', 'Slot ' + nn + ': FAIL -> Sin respuesta (vacío o apagado).');
      }
      enviar('tc-slot', res);
      t.hechos++;
      emitirEstado();
    });
    if (t.abort) {
      linea('sys', '■ Escaneo detenido por el usuario. No se modificó el archivo.');
      return { ok: true, detenido: true };
    }
    const ruta = escribirArchivo(slots);
    linea('sys', '[ÉXITO] Archivo ' + ruta + ' guardado y actualizado.');
    enviar('tc-slots', { slots });
    return { ok: true, slots };
  } catch (e) {
    linea('err', 'Error en el escaneo: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    cerrarTrabajo();
  }
}

/* ---------- Ejecución del UUT_case ---------- */
async function correr(slotsEntrada, seleccion) {
  const norm = normalizarSlots(slotsEntrada);
  if (!norm.ok) return norm;
  let elegidos = null;
  if (Array.isArray(seleccion)) {
    elegidos = [...new Set(seleccion.map(Number))].filter((n) => n >= 1 && n <= NUM_SLOTS).sort((a, b) => a - b);
    if (!elegidos.length) return { ok: false, error: 'No se seleccionaron slots válidos (1-16).' };
  } else if (seleccion !== 'todos') {
    return { ok: false, error: 'Selección no válida.' };
  }
  const t = abrirTrabajo('ejecucion', elegidos ? elegidos.length : NUM_SLOTS);
  if (!t) return ocupado();

  let ruta;
  try {
    ruta = escribirArchivo(norm.slots);   // el archivo siempre queda igual a la tabla antes de correr
  } catch (e) {
    linea('err', 'No se pudo guardar el archivo: ' + e.message);
    cerrarTrabajo();
    return { ok: false, error: 'No se pudo guardar el archivo: ' + e.message };
  }
  linea('sys', '[ÉXITO] Archivo ' + ruta + ' guardado y actualizado.');

  let args, descr;
  if (elegidos) {
    const cmd = elegidos.map((n) => comandoSlot(n, norm.slots[n - 1])).join(' && ');
    args = ['-c', cmd];
    descr = 'slots ' + elegidos.join(', ');
    linea('sys', '[EJECUTANDO] Corriendo ' + descr + ' en secuencia…');
    for (const n of elegidos) linea('sys', '$ ' + comandoSlot(n, norm.slots[n - 1]));
  } else {
    args = [ruta];
    descr = 'todo el ' + CONFIG.NOMBRE_ARCHIVO;
    linea('sys', '[EJECUTANDO] Procesando comandos en secuencia (' + ruta + ')…');
  }

  // Corre en segundo plano y manda toda la salida a la consola (la barra de progreso es indeterminada)
  const codigo = await new Promise((resolve) => {
    let fin = false;
    const listo = (c) => { if (!fin) { fin = true; resolve(c); } };
    let proc;
    try {
      proc = spawn('bash', args, {
        cwd: path.dirname(ruta),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb', NO_COLOR: '1' }
      });
    } catch (e) { linea('err', 'No se pudo iniciar bash: ' + e.message); return listo(-1); }
    t.proc = proc;
    const out = crearLector('out'), err = crearLector('err');
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('spawn', () => linea('sys', 'bash · PID ' + proc.pid));
    proc.on('error', (e) => { out.flush(); err.flush(); linea('err', 'Error: ' + e.message); listo(-1); });
    proc.on('close', (c) => { out.flush(); err.flush(); listo(c === null ? -1 : c); });
  });

  const seg = ((Date.now() - t.inicio) / 1000).toFixed(1);
  let resultado;
  if (t.abort) { linea('sys', '■ Ejecución detenida por el usuario · ' + seg + ' s'); resultado = { ok: true, detenido: true }; }
  else if (codigo === 0) { linea('sys', '✓ [ÉXITO] La ejecución ha finalizado (código 0) · ' + seg + ' s'); resultado = { ok: true, codigo }; }
  else { linea('sys', '✕ La ejecución terminó con código ' + codigo + ' · ' + seg + ' s (con && se detiene en el primer comando que falla)'); resultado = { ok: true, codigo }; }
  t.hechos = t.total;
  cerrarTrabajo();
  return resultado;
}


/* ---------- Canales con la ventana ---------- */
ipcMain.handle('tc-get', () => ({ ...estadoPublico(), ...leerArchivo(), numSlots: NUM_SLOTS }));
ipcMain.handle('tc-hist', () => hist);

ipcMain.handle('tc-save', (_e, slotsEntrada) => {
  const norm = normalizarSlots(slotsEntrada);
  if (!norm.ok) return norm;
  if (trabajo && trabajo.tipo === 'ejecucion') return { ok: false, error: 'No se puede guardar mientras se ejecuta.' };
  try {
    const ruta = escribirArchivo(norm.slots);
    linea('sys', '[ÉXITO] Archivo ' + ruta + ' guardado y actualizado.');
    flush();
    emitirEstado();
    return { ok: true, ruta };
  } catch (e) {
    linea('err', 'No se pudo guardar el archivo: ' + e.message);
    flush();
    return { ok: false, error: 'No se pudo guardar el archivo: ' + e.message };
  }
});

ipcMain.handle('tc-set-path', async (e) => {
  if (trabajo) return { ok: false, error: 'Espera a que termine el trabajo en curso.' };
  const win = BrowserWindow.fromWebContents(e.sender) || undefined;
  const r = await dialog.showSaveDialog(win, {
    title: 'Ubicación del archivo ' + CONFIG.NOMBRE_ARCHIVO,
    defaultPath: obtenerRuta(),
    buttonLabel: 'Usar este archivo'
  });
  if (r.canceled || !r.filePath) return { ok: true, cambio: false };
  guardarRutaCfg(r.filePath);
  linea('sys', 'Archivo de trabajo: ' + r.filePath);
  flush();
  emitirEstado();
  return { ok: true, cambio: true };
});

ipcMain.handle('tc-scan', () => { if (trabajo) return ocupado(); escanear(); return { ok: true }; });
ipcMain.handle('tc-run', (_e, slots, seleccion) => correr(slots, seleccion));

// Visor: contenido del archivo UUT_case generado
ipcMain.handle('tc-read-file', async () => {
  const ruta = obtenerRuta();
  try {
    if (!fs.existsSync(ruta)) return { ok: true, ruta, existe: false, texto: '' };
    const st = await fs.promises.stat(ruta);
    if (st.size > 2 * 1024 * 1024) return { ok: false, ruta, error: 'El archivo es muy grande para mostrarlo (' + Math.round(st.size / 1024) + ' KB).' };
    const texto = await fs.promises.readFile(ruta, 'utf8');
    return { ok: true, ruta, existe: true, texto, mtime: st.mtimeMs, tam: st.size };
  } catch (e) {
    return { ok: false, ruta, error: 'No se pudo leer ' + ruta + ': ' + e.message };
  }
});

ipcMain.handle('tc-open-file', async () => {
  const ruta = obtenerRuta();
  if (!fs.existsSync(ruta)) return { ok: false, error: 'El archivo aún no existe: ' + ruta };
  const err = await shell.openPath(ruta);   // '' si se abrió bien
  return err ? { ok: false, error: 'No se pudo abrir: ' + err } : { ok: true, ruta };
});

ipcMain.handle('tc-stop', () => {
  if (!trabajo) return { ok: false };
  trabajo.abort = true;
  linea('sys', '… Deteniendo ' + trabajo.tipo);
  if (trabajo.proc) trabajo.killTimer = matarArbol(trabajo.proc);
  flush();
  return { ok: true };
});

ipcMain.handle('tc-open-log', () => {
  const dir = path.join(app.getPath('userData'), 'logs', 'testcase');
  const log = (trabajo && trabajo.log) || ultimoLog;
  if (log && fs.existsSync(log)) shell.showItemInFolder(log);
  else { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); }
  return true;
});

app.on('before-quit', () => { if (trabajo) { trabajo.abort = true; matarArbol(trabajo.proc); } });
console.log('[testcase] módulo de Test case cargado');
