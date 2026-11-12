'use strict';
/* ============================================================
   DAQ MONITOR (proceso principal)
   Corre TU script server/daq.py tal cual (pyvisa al DAQ970A) y lee lo que imprime:
     Conectado a: Keysight Technologies,DAQ970A,...
     Canal 01 (101): 0.907901 V
   La ventana lo acomoda en la tabla de 16 canales.
   - El script se puede ver y modificar desde la app (copia en la carpeta de datos).
   - "Instalar pyvisa" corre: python3 -m pip install --user pyvisa pyvisa-py
   Se carga desde main.js con:  require('./daq_main.js');
   ============================================================ */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bitacora = require('./bitacora.js');

const LIMITE_MS = 60 * 1000;               // una lectura no puede tardar más (el script espera hasta 20 s al equipo)
const LIMITE_PIP_MS = 5 * 60 * 1000;
const REGEX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const SOBRECARGA = 9e37;                    // el DAQ manda +9.9E+37 cuando el canal está fuera de rango

const DAQ_ORIGINAL = [path.join(__dirname, 'server', 'daq.py'), path.join(__dirname, 'daq.py')]
  .find((r) => { try { return fs.existsSync(r); } catch (e) { return false; } }) || path.join(__dirname, 'server', 'daq.py');
const rutaDaq = () => path.join(app.getPath('userData'), 'daq.py');
function scriptDaq() {
  const r = rutaDaq();
  if (!fs.existsSync(r)) {
    if (!fs.existsSync(DAQ_ORIGINAL)) throw new Error('La app no trae daq.py (debe ir en la carpeta server/ del proyecto)');
    fs.mkdirSync(path.dirname(r), { recursive: true });
    fs.writeFileSync(r, fs.readFileSync(DAQ_ORIGINAL), { mode: 0o755 });
  }
  return r;
}

let proc = null;          // lectura o pip corriendo
let tarea = '';           // 'leer' | 'pip'
let monitoreando = false; // la ventana avisa si está en modo Monitorear
let detenido = false;     // el usuario le dio Detener

function enviar(canal, datos) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.__izumi) w.webContents.send(canal, datos);
}
const log = (texto, tipo) => enviar('daq-log', { texto, tipo: tipo || 'out', t: Date.now() });

function matar(p) {
  if (!p || !p.pid) return;
  try {
    if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); return; }
    process.kill(-p.pid, 'SIGTERM');
    setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {} }, 3000);
  } catch (e) { try { p.kill(); } catch (e2) {} }
}

/* Corre un comando, manda cada renglón a la consola y regresa todo lo que imprimió */
function correr(cmd, args, limiteMs) {
  return new Promise((res) => {
    let texto = '', resto = '', vencido = false;
    let p;
    try {
      p = spawn(cmd, args, {
        cwd: app.getPath('userData'), detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb' }
      });
    } catch (e) { return res({ codigo: -1, texto: '', error: 'No se pudo correr ' + cmd + ': ' + e.message }); }
    proc = p;
    const tomar = (b) => {
      const s = b.toString('utf8').replace(REGEX_ANSI, '');
      texto += s;
      const partes = (resto + s).split(/\r?\n/);
      resto = partes.pop();
      for (const l of partes) if (l.trim()) log(l, /Error|ERROR|Traceback|⚠️|No module named/.test(l) ? 'err' : 'out');
    };
    p.stdout.on('data', tomar);
    p.stderr.on('data', tomar);
    p.stdin.on('error', () => {});
    p.stdin.end();
    const limite = setTimeout(() => { vencido = true; matar(p); }, limiteMs);
    let listo = false;
    const fin = (codigo, error) => {
      if (listo) return; listo = true;
      clearTimeout(limite);
      if (resto.trim()) log(resto, 'out');
      if (proc === p) proc = null;
      res({ codigo, texto, vencido, error: error || '' });
    };
    p.on('error', (e) => fin(-1, e.code === 'ENOENT' ? 'No se encontró ' + cmd + ' en este equipo' : e.message));
    p.on('close', (c) => fin(c));
  });
}

/* Lee lo que imprimió daq.py */
function leerSalida(texto) {
  const s = String(texto || '').replace(REGEX_ANSI, '');
  const idn = ((s.match(/Conectado a:\s*(.+)/) || [])[1] || '').trim();
  const canales = [];
  const re = /Canal\s+(\d+)\s*\((\d+)\)\s*:\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*V/g;
  let m;
  while ((m = re.exec(s))) {
    const v = Number(m[3]);
    canales.push({ n: Number(m[1]), canal: Number(m[2]), v, sobrecarga: Math.abs(v) >= SOBRECARGA });
  }
  let error = '', falta = '';
  const mod = s.match(/No module named '([^'.]+)/);
  if (mod) { falta = mod[1]; error = 'Falta el módulo de Python "' + mod[1] + '". Dale a Instalar pyvisa.'; }
  else if (/El DAQ reportó un problema de configuración/.test(s)) {
    error = s.split('\n').filter((l) => /problema de configuración|Revisa qué modelo/.test(l)).map((l) => l.replace(/^⚠️\s*/, '').trim()).join(' ');
  } else if (/Error de comunicación con el equipo/.test(s)) error = (s.match(/Error de comunicación con el equipo:.*/) || [''])[0].trim();
  else if (/Traceback/.test(s)) error = (s.trim().split('\n').filter((l) => l.trim()).pop() || 'El script falló').trim();
  else if (!canales.length) error = 'El script no imprimió lecturas de canales.';
  return { idn, canales, error, falta };
}

ipcMain.handle('daq-leer', async () => {
  if (proc) return { ok: false, ocupado: true, error: tarea === 'pip' ? 'Se está instalando pyvisa, espera.' : 'Ya hay una lectura en curso.' };
  let ruta;
  try { ruta = scriptDaq(); } catch (e) { return { ok: false, error: e.message }; }
  tarea = 'leer';
  detenido = false;
  const inicio = Date.now();
  log('--- Lectura ' + new Date(inicio).toLocaleTimeString() + ' ---', 'sys');
  const r = await correr('python3', ['-u', ruta], LIMITE_MS);
  tarea = '';
  const res = leerSalida(r.texto);
  if (r.error) res.error = r.error;
  if (r.vencido) res.error = 'El equipo no contestó en ' + (LIMITE_MS / 1000) + ' s (se detuvo la lectura).';
  if (detenido && !res.canales.length) res.error = 'Lectura detenida.';
  const ok = res.canales.length > 0 && !(r.vencido);
  return { ok, ...res, ms: Date.now() - inicio, t: Date.now() };
});

ipcMain.handle('daq-detener', () => { if (proc) { detenido = true; matar(proc); } return { ok: true }; });
ipcMain.handle('daq-monitor', (_e, on) => { monitoreando = !!on; if (on) bitacora.registrar('DAQ monitor', 'Inició monitoreo', ''); return { ok: true }; });

ipcMain.handle('daq-instalar', async () => {
  if (proc) return { ok: false, error: 'Espera a que termine la lectura.' };
  tarea = 'pip';
  log('--- Instalando pyvisa y pyvisa-py ---', 'sys');
  const base = ['-m', 'pip', 'install', '--user', 'pyvisa', 'pyvisa-py'];
  let r = await correr('python3', base, LIMITE_PIP_MS);
  if (r.codigo !== 0 && /externally-managed-environment|--break-system-packages/.test(r.texto)) {
    log('Este Linux protege el Python del sistema; reintento con --break-system-packages (solo para tu usuario).', 'sys');
    r = await correr('python3', [...base, '--break-system-packages'], LIMITE_PIP_MS);
  }
  tarea = '';
  if (r.codigo === 0) {
    bitacora.registrar('DAQ monitor', 'Instaló pyvisa y pyvisa-py', '');
    log('Listo: pyvisa instalado.', 'ok');
    return { ok: true };
  }
  let error = r.error || 'pip no pudo instalar (revisa Ver detalles).';
  if (/No module named pip/.test(r.texto)) error = 'Este equipo no tiene pip. Instálalo con: sudo apt install python3-pip';
  else if (/Could not find a version|Failed to establish|Temporary failure|No matching distribution/.test(r.texto)) error = 'pip no pudo descargar (¿hay internet o mirror en este equipo?).';
  return { ok: false, error };
});

/* ---------- El script: ver, modificar, restaurar ---------- */
ipcMain.handle('daq-script-leer', () => {
  try {
    const r = scriptDaq();
    const texto = fs.readFileSync(r, 'utf8');
    let original = '';
    try { original = fs.readFileSync(DAQ_ORIGINAL, 'utf8'); } catch (e) {}
    return { ok: true, ruta: r, texto, esOriginal: texto === original };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('daq-script-guardar', (_e, texto) => {
  const t = String(texto || '');
  if (!t.trim()) return { ok: false, error: 'El script no puede quedar vacío.' };
  if (proc) return { ok: false, error: 'Espera a que termine la lectura.' };
  try {
    scriptDaq();
    fs.writeFileSync(rutaDaq(), t.endsWith('\n') ? t : t + '\n', { mode: 0o755 });
    bitacora.registrar('DAQ monitor', 'Modificó el script del DAQ', rutaDaq());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('daq-script-restaurar', () => {
  if (proc) return { ok: false, error: 'Espera a que termine la lectura.' };
  try {
    fs.mkdirSync(path.dirname(rutaDaq()), { recursive: true });
    fs.writeFileSync(rutaDaq(), fs.readFileSync(DAQ_ORIGINAL), { mode: 0o755 });
    bitacora.registrar('DAQ monitor', 'Restauró el script del DAQ original', rutaDaq());
    return { ok: true, texto: fs.readFileSync(rutaDaq(), 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.on('before-quit', () => { if (proc) matar(proc); });

module.exports = {
  ocupado: () => !!proc || monitoreando,
  _prueba: { leerSalida }
};
