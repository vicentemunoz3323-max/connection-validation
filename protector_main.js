'use strict';
/* ============================================================
   PROTECTOR DE PANTALLA (proceso principal)
   Pone un aviso a pantalla completa en TODOS los monitores ("Equipo en mantenimiento",
   "Equipo caído"…) que no deja usar la PC hasta que alguien escriba la contraseña de root.

   - Las ventanas son kiosco, siempre encima y no se pueden cerrar (Alt+F4 no las quita).
   - Si la app se cierra o se reinicia con el aviso puesto, al abrir vuelve a salir
     (se guarda en <userData>/protector.json).
   - La contraseña se revisa con "su root -c true" en una terminal virtual (pty);
     no se guarda en ningún lado.
   ============================================================ */
const { ipcMain, BrowserWindow, screen, app, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bitacora = require('./bitacora.js');

const AVISOS = {
  mantenimiento: { titulo: 'Equipo en mantenimiento', sub: 'No ingresar unidades', color: '#f59e0b', icono: 'llave' },
  memoria:       { titulo: 'Equipo con bajo nivel de memoria', sub: 'Llama al equipo de pruebas', color: '#2563eb', icono: 'memoria' },
  almacenamiento:{ titulo: 'Equipo con poco almacenamiento', sub: 'Llama al equipo de pruebas', color: '#7c3aed', icono: 'disco' },
  caido:         { titulo: 'Equipo caído', sub: 'No ingresar unidades', color: '#dc2626', icono: 'alto' }
};

/* ---------- Personalización (se guarda en <userData>/protector-config.json) ---------- */
const CONFIG_BASE = { burbujas: true, nBurbujas: 26, pez: true, nPeces: 1, reloj: true, fondo: 'claro', imagen: 'original', avisos: {} };
const archivoConfig = () => path.join(app.getPath('userData'), 'protector-config.json');
const dirImagen = () => path.join(app.getPath('userData'), 'protector-imagen');
const COLOR_OK = /^#[0-9a-f]{6}$/i;
function leerConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(archivoConfig(), 'utf8')) || {}; } catch (e) {}
  return { ...CONFIG_BASE, ...c, avisos: { ...(c.avisos || {}) } };
}
function limpiarConfig(o) {
  const c = leerConfig(), n = (v, a, b, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
  if (!o || typeof o !== 'object') return c;
  const r = {
    burbujas: o.burbujas !== false, nBurbujas: n(o.nBurbujas, 4, 80, CONFIG_BASE.nBurbujas),
    pez: o.pez !== false, nPeces: n(o.nPeces, 1, 5, 1), reloj: o.reloj !== false,
    fondo: ['claro', 'oscuro', 'agua'].includes(o.fondo) ? o.fondo : 'claro',
    imagen: ['original', 'propia', 'ninguna'].includes(o.imagen) ? o.imagen : c.imagen, avisos: {}
  };
  for (const k of Object.keys(AVISOS)) {
    const a = (o.avisos && o.avisos[k]) || {};
    const x = {};
    if (typeof a.titulo === 'string' && a.titulo.trim()) x.titulo = a.titulo.trim().slice(0, 80);
    if (typeof a.sub === 'string' && a.sub.trim()) x.sub = a.sub.trim().slice(0, 120);
    if (typeof a.color === 'string' && COLOR_OK.test(a.color)) x.color = a.color;
    if (Object.keys(x).length) r.avisos[k] = x;
  }
  return r;
}
const avisoDe = (tipo, cfg) => ({ ...AVISOS[tipo], ...((cfg || leerConfig()).avisos[tipo] || {}) });
function imagenPropia() {
  try {
    const f = fs.readdirSync(dirImagen()).find((x) => /^imagen\.(png|jpe?g|webp|gif|svg)$/i.test(x));
    if (!f) return null;
    const ext = f.split('.').pop().toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
    return 'data:' + mime + ';base64,' + fs.readFileSync(path.join(dirImagen(), f)).toString('base64');
  } catch (e) { return null; }
}
function datosVisuales(cfg) {
  const c = cfg || leerConfig();
  let imagen = 'protector.png';
  if (c.imagen === 'ninguna') imagen = null;
  else if (c.imagen === 'propia') imagen = imagenPropia() || 'protector.png';
  return { burbujas: c.burbujas, nBurbujas: c.nBurbujas, pez: c.pez, nPeces: c.nPeces, reloj: c.reloj, fondo: c.fondo, imagen };
}

let envolver = async (cmd) => cmd;      // main.js lo cambia para salir del "no new privileges" (systemd-run)
let ventanas = [];
let activo = null;                      // { tipo, desde, nota }
let permitirCierre = false;
let intentos = [];                      // horas de intentos fallidos (para frenar a quien adivina)

const archivoEstado = () => path.join(app.getPath('userData'), 'protector.json');
function guardarEstado() {
  try {
    if (activo) fs.writeFileSync(archivoEstado(), JSON.stringify(activo));
    else fs.rmSync(archivoEstado(), { force: true });
  } catch (e) {}
}

function crearVentanas() {
  cerrarVentanas();
  permitirCierre = false;
  const pantallas = screen.getAllDisplays();
  pantallas.forEach((d, n) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, kiosk: true, fullscreen: true, alwaysOnTop: true, skipTaskbar: true,
      movable: false, resizable: false, minimizable: false, maximizable: false, closable: false,
      focusable: true, backgroundColor: '#ffffff', show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'protector_preload.js') }
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true);
    w.on('close', (e) => { if (!permitirCierre) e.preventDefault(); });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Sin recargar, sin herramientas de desarrollo, sin zoom
    w.webContents.on('before-input-event', (e, inp) => {
      const k = String(inp.key || '').toLowerCase();
      if ((inp.control || inp.meta) && ['r', 'w', 'q', 'i', '+', '-', '=', '0'].includes(k)) e.preventDefault();
      if (['f5', 'f11', 'f12'].includes(k)) e.preventDefault();
    });
    w.once('ready-to-show', () => { w.show(); w.setKiosk(true); if (n === 0) w.focus(); });
    // si le quitan el foco (otra ventana), lo recupera
    w.on('blur', () => setTimeout(() => { if (activo && !w.isDestroyed() && !BrowserWindow.getFocusedWindow()) { w.show(); w.focus(); } }, 300));
    w.loadFile(path.join(__dirname, 'protector.html'), { query: { tipo: activo.tipo, principal: n === 0 ? '1' : '0' } });
    ventanas.push(w);
  });
}
function cerrarVentanas() {
  permitirCierre = true;
  for (const w of ventanas) { try { if (!w.isDestroyed()) { w.setClosable(true); w.setKiosk(false); w.destroy(); } } catch (e) {} }
  ventanas = [];
}

function lanzar(tipo, nota) {
  if (!AVISOS[tipo]) return { ok: false, error: 'Aviso desconocido' };
  activo = { tipo, desde: Date.now(), nota: String(nota || '').slice(0, 200) };
  guardarEstado();
  crearVentanas();
  bitacora.registrar('Protector de pantalla', 'Se puso el aviso', avisoDe(tipo).titulo + (activo.nota ? ' · ' + activo.nota : ''));
  return { ok: true };
}

/* ---------- Revisar la contraseña de root ---------- */
// su pide la contraseña en una terminal (no por stdin), por eso se usa una pty de Python.
const VERIFICADOR = `
import os, pty, re, select, sys, time
pw = sys.stdin.readline().rstrip("\\n")
pid, fd = pty.fork()
if pid == 0:
    os.environ["LC_ALL"] = "C"; os.environ["LANG"] = "C"
    os.execvp("su", ["su", "root", "-c", "true"])
buf = b""; enviada = False; fin = time.time() + 25
while time.time() < fin:
    r, _, _ = select.select([fd], [], [], 0.3)
    if not r:
        try:
            p, st = os.waitpid(pid, os.WNOHANG)
            if p: sys.exit(os.waitstatus_to_exitcode(st) if enviada else 3)
        except ChildProcessError: break
        continue
    try: d = os.read(fd, 1024)
    except OSError: break
    if not d: break
    buf += d
    if not enviada and re.search(rb"(?i)(password|contrase)", buf):
        time.sleep(0.15); os.write(fd, (pw + "\\n").encode()); enviada = True; buf = b""
_, st = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(st)
sys.exit(code if enviada else 3)
`;

async function revisarRoot(pass) {
  const base = ['python3', '-c', VERIFICADOR];
  const cmd = await envolver(base);
  return new Promise((resolve) => {
    let p, fin = false;
    try { p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 30000);
    p.stdin.on('error', () => {});
    p.stdin.write(pass + '\n'); p.stdin.end();
    const listo = (c) => {
      if (fin) return; fin = true; clearTimeout(t);
      if (c === 0) return resolve({ ok: true });
      if (c === 3) return resolve({ ok: false, error: 'No se pudo revisar la contraseña (su no la pidió).' });
      resolve({ ok: false, error: 'Contraseña incorrecta' });
    };
    p.on('error', (e) => listo(-1));
    p.on('close', (c) => listo(c === null ? -1 : c));
  });
}

/* ---------- Canales ---------- */
ipcMain.handle('prot-avisos', () => { const c = leerConfig(); const r = {}; for (const k of Object.keys(AVISOS)) r[k] = avisoDe(k, c); return r; });
ipcMain.handle('prot-config-leer', () => ({ config: leerConfig(), base: AVISOS, imagenPropia: imagenPropia() }));
ipcMain.handle('prot-config-guardar', (_e, o) => {
  const c = limpiarConfig(o);
  try { fs.writeFileSync(archivoConfig(), JSON.stringify(c, null, 2)); } catch (e) { return { ok: false, error: e.message }; }
  bitacora.registrar('Protector de pantalla', 'Se cambió la personalización', '');
  return { ok: true, config: c };
});
ipcMain.handle('prot-imagen-elegir', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Imagen para el protector de pantalla', properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelado: true };
  const origen = r.filePaths[0];
  try {
    if (fs.statSync(origen).size > 15 * 1024 * 1024) return { ok: false, error: 'La imagen pesa más de 15 MB.' };
    fs.rmSync(dirImagen(), { recursive: true, force: true });
    fs.mkdirSync(dirImagen(), { recursive: true });
    fs.copyFileSync(origen, path.join(dirImagen(), 'imagen.' + path.extname(origen).slice(1).toLowerCase()));
  } catch (err) { return { ok: false, error: 'No se pudo copiar la imagen: ' + err.message }; }
  return { ok: true, imagen: imagenPropia() };
});
let vistaPrevia = null;
ipcMain.handle('prot-vista-previa', (_e, tipo, cfgTemporal) => {
  if (!AVISOS[tipo]) return { ok: false };
  try { if (vistaPrevia && !vistaPrevia.isDestroyed()) vistaPrevia.destroy(); } catch (e) {}
  const d = screen.getPrimaryDisplay().workArea;
  vistaPrevia = new BrowserWindow({
    width: Math.min(1280, d.width - 80), height: Math.min(760, d.height - 80), title: 'Vista previa del aviso', autoHideMenuBar: true,
    backgroundColor: '#ffffff', webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'protector_preload.js') }
  });
  vistaPrevia.__previa = { tipo, cfg: cfgTemporal ? limpiarConfig(cfgTemporal) : null };
  vistaPrevia.on('closed', () => { vistaPrevia = null; });
  vistaPrevia.loadFile(path.join(__dirname, 'protector.html'), { query: { tipo, vista: '1' } });
  return { ok: true };
});
ipcMain.handle('prot-cerrar-previa', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && w === vistaPrevia) w.close(); return true; });
ipcMain.handle('prot-estado', () => activo);
ipcMain.handle('prot-lanzar', (_e, tipo, nota) => lanzar(tipo, nota));
ipcMain.handle('prot-info', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w.__previa) {           // ventana de vista previa: datos de ejemplo
    const c = w.__previa.cfg || leerConfig();
    return { tipo: w.__previa.tipo, desde: Date.now() - 25 * 60000, nota: 'Así se ve la nota opcional', aviso: avisoDe(w.__previa.tipo, c), equipo: os.hostname(), visual: datosVisuales(c), previa: true };
  }
  if (!activo) return null;
  const c = leerConfig();
  return { ...activo, aviso: avisoDe(activo.tipo, c), equipo: os.hostname(), visual: datosVisuales(c) };
});
ipcMain.handle('prot-desbloquear', async (_e, pass) => {
  if (!activo) return { ok: true };
  if (typeof pass !== 'string' || !pass || pass.length > 300) return { ok: false, error: 'Escribe la contraseña de root' };
  const ahora = Date.now();
  intentos = intentos.filter((t) => ahora - t < 5 * 60000);
  if (intentos.length >= 5) {
    const espera = Math.ceil((intentos[0] + 5 * 60000 - ahora) / 1000);
    return { ok: false, error: `Demasiados intentos. Espera ${espera > 60 ? Math.ceil(espera / 60) + ' min' : espera + ' s'}.` };
  }
  const r = await revisarRoot(pass);
  if (!r.ok) {
    if (r.error === 'Contraseña incorrecta') intentos.push(ahora);
    bitacora.registrar('Protector de pantalla', 'Intento de quitar el aviso', r.error);
    return r;
  }
  const tipo = activo.tipo;
  activo = null; intentos = [];
  guardarEstado();
  cerrarVentanas();
  bitacora.registrar('Protector de pantalla', 'Se quitó el aviso', AVISOS[tipo].titulo);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('prot-cambio', null);
  return { ok: true };
});

// Al abrir la app: si el aviso estaba puesto, vuelve a salir
function restaurar() {
  try {
    const e = JSON.parse(fs.readFileSync(archivoEstado(), 'utf8'));
    if (e && AVISOS[e.tipo]) { activo = e; crearVentanas(); bitacora.registrar('Protector de pantalla', 'Se volvió a poner al abrir la app', AVISOS[e.tipo].titulo); }
  } catch (err) {}
}
// Si conectan o quitan un monitor, se vuelven a cubrir todos
function vigilarPantallas() {
  const rehacer = () => { if (activo) setTimeout(crearVentanas, 500); };
  screen.on('display-added', rehacer);
  screen.on('display-removed', rehacer);
}

module.exports = {
  configurar: (o) => { if (o && typeof o.envolver === 'function') envolver = o.envolver; },
  iniciar: () => { vigilarPantallas(); restaurar(); },
  activo: () => activo,
  AVISOS, revisarRoot, _VERIFICADOR: VERIFICADOR
};
console.log('[protector] protector de pantalla listo');
