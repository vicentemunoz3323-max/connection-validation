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
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');   // lo usa Correr todo (crearLector)
const bitacora = require('./bitacora.js');

/* ---------- Valores del script original (edítalos aquí si cambian) ---------- */
const CONFIG = {
  NOMBRE_ARCHIVO: 'UUT_case',
  RUTA_BASE: '~/viper-test/opentest/tools/ot_regression.py',
  // Los seriales los saca TU script (server/fru_serial.py): ZPE, BMC, ping y hexdump van ahí.
  FRU_A_LA_VEZ: 8,                             // slots que corren el script de seriales al mismo tiempo
  FRU_LIMITE_MS: 7 * 60 * 1000                 // un slot no puede tardar más de esto (el script espera hasta 5 min el ping)
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

function leerCfg() {
  try { const j = JSON.parse(fs.readFileSync(rutaCfg(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
}
function escribirCfg(cambios) {
  try {
    fs.mkdirSync(path.dirname(rutaCfg()), { recursive: true });
    fs.writeFileSync(rutaCfg(), JSON.stringify({ ...leerCfg(), ...cambios }));
  } catch (e) {}
}

function obtenerRuta() {
  if (rutaUUT) return rutaUUT;
  const j = leerCfg();
  rutaUUT = typeof j.ruta === 'string' && j.ruta ? j.ruta : path.join(os.homedir(), CONFIG.NOMBRE_ARCHIVO);
  return rutaUUT;
}
function guardarRutaCfg(r) {
  rutaUUT = r;
  escribirCfg({ ruta: r });
}

// Script de Python que genera el UUT_case (uut_case.py, el piloto, o como lo hayas renombrado)
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
  if (texto.startsWith('@@SLOT ')) {
    try {
      const d = JSON.parse(texto.slice(7));
      if (d && d.n >= 1 && d.n <= NUM_SLOTS) {
        enviar('tc-slot', d);
        if (trabajo && (d.estado === 'ok' || d.estado === 'fail')) { trabajo.hechos++; emitirEstado(); }
      }
      return;
    } catch (e) {}
  }
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
    const dir = bitacora.dir('testcase');
    log = path.join(dir, tipo + '_' + fechaTxt(inicio).replace(/[: ]/g, '-') + '.log');
    logStream = fs.createWriteStream(log, { flags: 'a' });
    logStream.on('error', () => {});   // un fallo de disco no debe tumbar la app
    logStream.write('# Generar Test case · ' + tipo + ' · ' + fechaTxt(inicio) + '\n\n');
  } catch (e) { logStream = null; }
  trabajo = { tipo, inicio, total, hechos: 0, abort: false, proc: null, log, logStream, killTimer: null };
  bitacora.registrar('Test case', { escaneo: 'Inició escaneo de slots', script: 'Generó con script', ejecucion: 'Inició ejecución' }[tipo] || tipo, total ? total + ' slot(s)' : '');
  ultimoLog = log;
  emitirEstado();
  return trabajo;
}
function cerrarTrabajo(resumen) {
  if (!trabajo) return;
  bitacora.registrar('Test case', 'Terminó ' + trabajo.tipo + (trabajo.abort ? ' (detenido por el usuario)' : ''),
    (resumen || '') + ' · ' + ((Date.now() - trabajo.inicio) / 1000).toFixed(1) + ' s' + (trabajo.log ? ' · ' + trabajo.log : ''));
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

/* ---------- Script de seriales (el de siempre: fru_serial.py) ----------
   Se puede ver y modificar desde la pantalla. La app trabaja con una copia en la carpeta de la app;
   el original viene dentro de la app (server/fru_serial.py) y se puede restaurar. */
// Se busca en server/ y, por si acaso, en la raíz de la app
const FRU_ORIGINAL = [path.join(__dirname, 'server', 'fru_serial.py'), path.join(__dirname, 'fru_serial.py')]
  .find((r) => { try { return fs.existsSync(r); } catch (e) { return false; } }) || path.join(__dirname, 'server', 'fru_serial.py');
const rutaFru = () => path.join(app.getPath('userData'), 'fru_serial.py');
function scriptFru() {
  const r = rutaFru();
  if (!fs.existsSync(r)) {
    if (!fs.existsSync(FRU_ORIGINAL)) throw new Error('La app no trae fru_serial.py (debe ir en la carpeta server/ del proyecto)');
    fs.writeFileSync(r, fs.readFileSync(FRU_ORIGINAL), { mode: 0o755 });
  }   // (se lee y escribe: el original vive dentro del paquete de la app)
  return r;
}
const sinColores = (t) => String(t).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

// Corre el script para UN slot: le escribe el número donde pregunta y lee lo que imprime
function correrFru(n, t) {
  return new Promise((res) => {
    const nn = dos(n);
    let texto = '', resto = '';
    let p;
    try {
      p = spawn('python3', ['-u', scriptFru()], {
        cwd: app.getPath('userData'), detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb' }
      });
    } catch (e) { return res({ error: 'No se pudo correr python3: ' + e.message }); }
    t.procs.add(p);
    const tomar = (b) => {
      const s = sinColores(b.toString('utf8'));
      texto += s;
      const partes = (resto + s).split('\n');
      resto = partes.pop();
      for (const l of partes) {
        const limpia = l.replace(/^Ingrese el numero de slot \(1-16\):\s*/, '');
        if (limpia.trim()) { linea(/ERROR|No se pudo|Error|Traceback/.test(limpia) ? 'err' : 'out', 'Slot ' + nn + ' · ' + limpia); if (t.logStream) t.logStream.write('[Slot ' + nn + '] ' + limpia + '\n'); }
      }
    };
    p.stdout.on('data', tomar);
    p.stderr.on('data', tomar);
    p.stdin.on('error', () => {});
    p.stdin.write(n + '\n');
    p.stdin.end();
    const limite = setTimeout(() => { texto += '\n(el slot tardó demasiado y se detuvo)'; matarArbol(p); }, CONFIG.FRU_LIMITE_MS);
    const fin = (codigo) => {
      clearTimeout(limite);
      t.procs.delete(p);
      if (resto.trim()) tomar(Buffer.from('\n'));
      res({ texto, codigo });
    };
    p.on('error', (e) => { clearTimeout(limite); t.procs.delete(p); res({ error: e.code === 'ENOENT' ? 'No está python3 en este equipo' : e.message }); });
    p.on('close', fin);
  });
}

// Lo que imprimió el script → parte y serial
function leerSalidaFru(texto) {
  const s = sinColores(texto);
  const serial = (s.match(/El serial correcto es:\s*(\S+)/) || s.match(/\bFLG\d{4}-\d{5}\b/) || [])[1] || (s.match(/\bFLG\d{4}-\d{5}\b/) || [])[0] || '';
  const parte = (s.match(/El part number correcto es:\s*(\d+)/) || [])[1] || '';
  let motivo = '';
  if (!serial && !parte) {
    const mod = s.match(/No module named '([^']+)'/);
    if (mod) motivo = 'Falta el módulo de Python "' + mod[1] + '" (pip install ' + mod[1] + ')';
    else if (/Validacion por ping/.test(s)) motivo = 'Sin respuesta al ping (vacío o apagado)';
    else motivo = (s.trim().split('\n').filter((l) => l.trim() && !/^Ingrese el numero/.test(l)).pop() || 'El script no imprimió el serial').slice(0, 160);
  }
  return { serial, parte, motivo };
}

async function escanearFru() {
  const t = abrirTrabajo('escaneo', NUM_SLOTS);
  if (!t) return ocupado();
  t.procs = new Set();
  linea('sys', '--- Generando ' + CONFIG.NOMBRE_ARCHIVO + ' con el script de seriales (' + CONFIG.FRU_A_LA_VEZ + ' slots a la vez) ---');
  try { scriptFru(); } catch (e) { linea('err', 'No se encontró el script de seriales: ' + e.message); cerrarTrabajo(); return { ok: false, error: e.message }; }
  const slots = Array.from({ length: NUM_SLOTS }, () => ({ parte: '', serial: '' }));
  const nums = Array.from({ length: NUM_SLOTS }, (_, i) => i + 1);
  try {
    await pool(nums, CONFIG.FRU_A_LA_VEZ, async (n) => {
      const nn = dos(n);
      enviar('tc-slot', { n, estado: 'verificando', msg: 'Corriendo script…' });
      const r = await correrFru(n, t);
      if (t.abort) return enviar('tc-slot', { n, estado: 'detenido', msg: 'Detenido' });
      let res;
      if (r.error) {
        res = { n, estado: 'fail', msg: r.error };
        linea('err', 'Slot ' + nn + ': FAIL -> ' + r.error);
      } else {
        const d = leerSalidaFru(r.texto);
        if (d.serial || d.parte) {
          slots[n - 1] = { parte: d.parte, serial: d.serial };
          res = { n, estado: 'ok', msg: 'SUCCESS', parte: d.parte, serial: d.serial };
          linea('out', 'Slot ' + nn + ': SUCCESS -> Parte: ' + d.parte + ', Serial: ' + d.serial);
        } else {
          res = { n, estado: 'fail', msg: d.motivo };
          linea('err', 'Slot ' + nn + ': FAIL -> ' + d.motivo);
        }
      }
      enviar('tc-slot', res);
      t.hechos++;
      emitirEstado();
    });
    if (t.abort) {
      linea('sys', '■ Detenido por el usuario. No se modificó el archivo.');
      return { ok: true, detenido: true };
    }
    const ruta = escribirArchivo(slots);
    linea('sys', '[ÉXITO] Archivo ' + ruta + ' guardado y actualizado.');
    enviar('tc-slots', { slots });
    t.resumen = slots.filter((s) => s.parte || s.serial).length + ' de 16 slots con unidad: ' + slots.map((s, i) => s.serial ? (i + 1) + '=' + s.parte + '/' + s.serial : null).filter(Boolean).join(', ');
    return { ok: true, slots };
  } catch (e) {
    linea('err', 'Error al generar: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    cerrarTrabajo(t.resumen);
  }
}

ipcMain.handle('tc-fru-leer', () => {
  try {
    const r = scriptFru();
    const texto = fs.readFileSync(r, 'utf8');
    let original = '';
    try { original = fs.readFileSync(FRU_ORIGINAL, 'utf8'); } catch (e) {}
    return { ok: true, ruta: r, texto, esOriginal: texto === original };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('tc-fru-guardar', (_e, texto) => {
  const t = String(texto || '');
  if (!t.trim()) return { ok: false, error: 'El script no puede quedar vacío.' };
  if (trabajo) return { ok: false, error: 'Espera a que termine lo que está corriendo.' };
  try {
    fs.writeFileSync(rutaFru(), t.endsWith('\n') ? t : t + '\n', { mode: 0o755 });
    bitacora.registrar('Test case', 'Modificó el script de seriales', rutaFru());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('tc-fru-restaurar', () => {
  if (trabajo) return { ok: false, error: 'Espera a que termine lo que está corriendo.' };
  try {
    fs.writeFileSync(rutaFru(), fs.readFileSync(FRU_ORIGINAL), { mode: 0o755 });
    bitacora.registrar('Test case', 'Restauró el script de seriales original', rutaFru());
    return { ok: true, texto: fs.readFileSync(rutaFru(), 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});

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
  cerrarTrabajo(descr + ' · código ' + codigo);
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
    bitacora.registrar('Test case', 'Guardó la tabla', ruta + ' · ' + norm.slots.map((s, i) => s.serial ? (i + 1) + '=' + s.parte + '/' + s.serial : null).filter(Boolean).join(', '));
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
  bitacora.registrar('Test case', 'Cambió la ubicación del archivo', r.filePath);
  linea('sys', 'Archivo de trabajo: ' + r.filePath);
  flush();
  emitirEstado();
  return { ok: true, cambio: true };
});

ipcMain.handle('tc-scan', () => { if (trabajo) return ocupado(); escanearFru(); return { ok: true }; });
ipcMain.handle('tc-script-run', () => { if (trabajo) return ocupado(); escanearFru(); return { ok: true }; });   // Generar = script de seriales
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

// Guardar el UUT_case editado a mano en el visor
ipcMain.handle('tc-write-file', async (_e, texto) => {
  if (trabajo) return { ok: false, error: 'Espera a que termine el trabajo en curso.' };
  if (typeof texto !== 'string') return { ok: false, error: 'Texto no válido.' };
  if (texto.length > 2 * 1024 * 1024) return { ok: false, error: 'El texto es demasiado grande.' };
  const ruta = obtenerRuta();
  try {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const tmp = ruta + '.guardando';
    await fs.promises.writeFile(tmp, texto.endsWith('\n') ? texto : texto + '\n', 'utf8');
    await fs.promises.rename(tmp, ruta);            // se reemplaza de golpe: nunca queda a medias
    try { fs.chmodSync(ruta, 0o755); } catch (e) {}
    linea('sys', '✎ Archivo editado a mano y guardado: ' + ruta);
    bitacora.registrar('Test case', 'Editó el archivo a mano', ruta);
    flush();
    emitirEstado();
    return { ok: true, ruta, ...leerArchivo() };
  } catch (e) {
    return { ok: false, error: 'No se pudo guardar: ' + e.message };
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
  bitacora.registrar('Test case', 'Presionó Detener', trabajo.tipo);
  if (trabajo.proc) trabajo.killTimer = matarArbol(trabajo.proc);
  if (trabajo.procs) for (const p of trabajo.procs) matarArbol(p);
  flush();
  return { ok: true };
});

ipcMain.handle('tc-open-log', () => {
  const dir = bitacora.dir('testcase');
  const log = (trabajo && trabajo.log) || ultimoLog;
  if (log && fs.existsSync(log)) shell.showItemInFolder(log);
  else { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); }
  return true;
});

app.on('before-quit', () => {
  if (!trabajo) return;
  trabajo.abort = true;
  matarArbol(trabajo.proc);
  if (trabajo.procs) for (const p of trabajo.procs) matarArbol(p);
});
module.exports.escaneando = () => !!(trabajo && trabajo.tipo === 'escaneo');
module.exports.ocupado = () => !!trabajo;   // para no actualizar a medio trabajo
module.exports._prueba = { leerSalidaFru };
console.log('[testcase] módulo de Test case cargado');
