'use strict';
/* ============================================================
   LOCK: bloquea la pantalla con peces (proceso principal) · el mismo de ORT Engine
   - Cubre todos los monitores. Mientras tanto la app y las consolas siguen trabajando abajo.
   - Se quita con la contraseña del usuario de la PC (la misma de Linux).
   - Las contraseñas se revisan con "su" dentro de una pty de Python. No se guardan en ningún lado
     y nunca van en los argumentos de un comando (se pasan por stdin).
   - Para que nadie se quede encerrado:
     · antes de bloquear se revisa que "su" pida contraseña; si no, no se bloquea
     · si la pantalla se cae, se vuelve a abrir en modo simple (sin animaciones)
     · si no carga en 10 s, se traba o el modo simple también se cae, el bloqueo se quita solo
     · si al desbloquear "su" no funciona, el bloqueo se quita y se avisa
   - Lo que pasa queda en <carpeta temporal>/connection-validation-<uid>/lock.log (nunca la contraseña)
     y en la bitácora de la app.
   ============================================================ */
const { ipcMain, BrowserWindow, screen, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');

const VERIFICADOR = `
import os, pty, re, select, sys, time
usuario = sys.argv[1]
solo_probar = len(sys.argv) > 2 and sys.argv[2] == "probar"
pw = sys.stdin.readline().rstrip("\\n")
pid, fd = pty.fork()
if pid == 0:
    os.environ["LC_ALL"] = "C"; os.environ["LANG"] = "C"
    os.execvp("su", ["su", usuario, "-c", "true"])
buf = b""; enviada = False; fin = time.time() + 12
while time.time() < fin:
    r, _, _ = select.select([fd], [], [], 0.3)
    if not r:
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            sys.exit((os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1) if enviada else 3)
        continue
    try: d = os.read(fd, 1024)
    except OSError: break
    if not d: break
    buf += d
    if not enviada and re.search(rb"(?i)(password|contrase)", buf):
        if solo_probar:
            os.kill(pid, 9); sys.exit(0)
        time.sleep(0.15); os.write(fd, (pw + "\\n").encode()); enviada = True; buf = b""
try:
    _, st = os.waitpid(pid, 0)
except ChildProcessError:
    sys.exit(3)
code = os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1
if enviada and code != 0:
    sys.stderr.write(buf.decode("utf-8", "replace").replace(pw, "***")[-200:])
sys.exit(code if enviada else 3)
`;

const archivoLog = () => path.join(os.tmpdir(), `connection-validation-${process.getuid ? process.getuid() : 'u'}`, 'lock.log');
let bitacora = null;
try { bitacora = require('./bitacora.js'); } catch (e) {}
const anotar = (accion, detalle) => { try { if (bitacora) bitacora.registrar('Lock', accion, detalle || ''); } catch (e) {} };
function registrar(msg) {
  try {
    fs.mkdirSync(path.dirname(archivoLog()), { recursive: true });
    fs.appendFileSync(archivoLog(), `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

// "su" no funciona si la app se abrió con "no new privileges" (por ejemplo desde VS Code)
function noNewPrivs() {
  try { return /NoNewPrivs:\s*1/.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch (e) { return false; }
}
const SYSTEMD_RUN = '/usr/bin/systemd-run';

function correr(base, pass) {
  return new Promise((resolve) => {
    const cmd = noNewPrivs() && fs.existsSync(SYSTEMD_RUN) ? [SYSTEMD_RUN, '--user', '--pipe', '--wait', '--quiet', '--collect', '--', ...base] : base;
    let p, fin = false, err = '';
    const listo = (c) => { if (!fin) { fin = true; clearTimeout(t); resolve({ codigo: c, salida: (pass ? err.split(pass).join('***') : err).trim().slice(-200) }); } };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} listo(3); }, 15000);
    try { p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } }); }
    catch (e) { err = e.message; return listo(3); }
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    p.stdin.write(pass + '\n'); p.stdin.end();
    p.on('error', (e) => { err = e.message; listo(3); });
    p.on('close', (c) => listo(c === null ? 1 : c));
  });
}
const conSu = (usuario, pass) => correr(['python3', '-c', VERIFICADOR, usuario], pass);
const conSudo = (pass) => correr(['sudo', '-k', '-S', '-p', '', '-v'], pass);
// ¿"su" pide contraseña en esta PC? (no se envía ninguna ni cuenta como intento fallido)
const suPideContrasena = async (usuario) => (await correr(['python3', '-c', VERIFICADOR, usuario, 'probar'], '')).codigo === 0;

// Se acepta la contraseña del usuario de la PC: el que abrió la app
function cuentas() {
  let lista = [];
  try { lista.push(os.userInfo().username); } catch (e) {}
  return lista.filter((c) => /^[a-z_][a-z0-9_.-]*$/i.test(c) && c !== 'root');
}

async function verificar(pass) {
  if (typeof pass !== 'string' || !pass || pass.length > 300 || /[\r\n]/.test(pass)) return { ok: false, error: 'Escribe la contraseña' };
  const lista = cuentas();
  if (!lista.length) return { ok: false, error: 'No se pudo revisar la contraseña: no hay un usuario válido.' };
  // Sirve por cualquiera de los dos caminos: "su" o "sudo"
  return new Promise((resolve) => {
    let listo = false, faltan = 2, su = null;
    const fin = (nombre, r) => {
      registrar(`revisión de contraseña de ${lista[0]} con ${nombre}: código ${r.codigo}${r.salida ? ' · ' + r.salida : ''}`);
      if (listo) return;
      if (nombre === 'su') su = r.codigo;
      if (r.codigo === 0) { listo = true; return resolve({ ok: true, usuario: lista[0] }); }
      if (--faltan === 0) resolve(su === 3
        ? { ok: false, sinRevisar: true, error: 'No se pudo revisar la contraseña (su no la pidió).' }
        : { ok: false, error: 'Contraseña incorrecta' });
    };
    conSu(lista[0], pass).then((r) => fin('su', r));
    conSudo(pass).then((r) => fin('sudo', r));
  });
}

let ventanas = [];
let activo = false;
let letrero = { titulo: '', subtitulo: '', encargado: '' };
const texto = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
let permitirCierre = false;
let avisar = () => {};

// Quita el bloqueo sin contraseña porque algo falló: mejor libre que con la PC trabada
function quitarPorFalla(motivo) {
  if (!activo) return;
  registrar('bloqueo quitado por falla: ' + motivo);
  anotar('Se quitó el bloqueo por falla', motivo);
  activo = false;
  cerrarVentanas();
  avisar(false, false, motivo);
}

function crearVentanas() {
  cerrarVentanas();
  permitirCierre = false;
  screen.getAllDisplays().forEach((d, n) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, kiosk: true, fullscreen: true, alwaysOnTop: true, skipTaskbar: true,
      movable: false, resizable: false, minimizable: false, maximizable: false, closable: false,
      backgroundColor: '#06283f', show: false,
      // sandbox: false porque main.js abre la app con --no-sandbox (la ventana principal ya trabaja así)
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'lock_preload.js') }
    });
    w.__lock = true;
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true);
    w.on('close', (e) => { if (!permitirCierre) e.preventDefault(); });
    // Si la pantalla no termina de cargar a tiempo, no se deja la PC trabada
    w.__guardia = setTimeout(() => quitarPorFalla('la pantalla de bloqueo no cargó en 10 s'), 10000);
    w.on('unresponsive', () => quitarPorFalla('la pantalla de bloqueo dejó de responder'));
    w.webContents.on('render-process-gone', (_e, det) => {
      const motivo = `${det && det.reason} (código ${det && det.exitCode})`;
      if (w.__simple) return quitarPorFalla('la pantalla de bloqueo se cerró: ' + motivo);
      // Primera caída: se vuelve a abrir sin animaciones para que siga bloqueada y se pueda usar
      registrar(`pantalla con animaciones cerrada: ${motivo}; se abre en modo simple`);
      w.__simple = true;
      clearTimeout(w.__guardia);
      w.__guardia = setTimeout(() => quitarPorFalla('la pantalla de bloqueo no cargó en 10 s'), 10000);
      w.loadFile(path.join(__dirname, 'lock.html'), { query: { simple: '1' } });
    });
    w.webContents.on('did-fail-load', (_e, cod, desc) => quitarPorFalla(`no cargó lock.html: ${cod} ${desc}`));
    w.webContents.on('preload-error', (_e, _p, err) => quitarPorFalla('falló lock_preload.js: ' + (err && err.message)));
    w.webContents.on('console-message', (_e, nivel, msg, linea) => { if (nivel >= 2) registrar(`lock.html:${linea} ${msg}`); });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('before-input-event', (e, inp) => {
      const k = String(inp.key || '').toLowerCase();
      if ((inp.control || inp.meta) && ['r', 'w', 'q', 'i', '+', '-', '=', '0'].includes(k)) e.preventDefault();
      if (['f5', 'f11', 'f12'].includes(k)) e.preventDefault();
    });
    w.once('ready-to-show', () => { w.show(); w.setKiosk(true); if (n === 0) { w.focus(); w.webContents.focus(); } });
    w.on('blur', () => setTimeout(() => {
      if (activo && !w.isDestroyed() && !BrowserWindow.getFocusedWindow()) { w.show(); w.focus(); }
    }, 300));
    w.loadFile(path.join(__dirname, 'lock.html'));
    ventanas.push(w);
  });
}
function cerrarVentanas() {
  permitirCierre = true;
  for (const w of ventanas) { clearTimeout(w.__guardia); try { if (!w.isDestroyed()) { w.setClosable(true); w.setKiosk(false); w.destroy(); } } catch (e) {} }
  ventanas = [];
}

function revisarHerramientas() {
  return new Promise((resolve) => exec('command -v su && command -v python3', { timeout: 5000 }, (err) => resolve(!err)));
}

function iniciar(opc = {}) {
  if (opc.avisar) avisar = opc.avisar;
  ipcMain.handle('auth:verificar', (_e, pass) => verificar(pass));
  ipcMain.handle('lock:activar', async (_e, datos) => {
    if (activo) return { ok: true };
    const d = datos || {};
    letrero = { titulo: texto(d.titulo, 60), subtitulo: texto(d.subtitulo, 90), encargado: texto(d.encargado, 50) };
    if (process.getuid && process.getuid() === 0) return { ok: false, error: 'La app corre como root: no se podría revisar la contraseña para quitar el bloqueo.' };
    // Sin estas herramientas no se podría desbloquear: mejor no bloquear
    if (!(await revisarHerramientas())) return { ok: false, error: 'Faltan "su" o "python3": no se podría quitar el bloqueo.' };
    const lista = cuentas();
    if (!lista.length || !(await suPideContrasena(lista[0]))) return { ok: false, error: 'En esta PC "su" no pide contraseña: no se podría quitar el bloqueo.' };
    activo = true;
    registrar('pantalla bloqueada');
    anotar('Pantalla bloqueada', [letrero.titulo, letrero.encargado].filter(Boolean).join(' · '));
    crearVentanas();
    avisar(true);
    return { ok: true };
  });
  ipcMain.handle('lock:info', () => ({ equipo: os.hostname(), cuentas: cuentas(), ...letrero }));
  ipcMain.handle('lock:listo', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) clearTimeout(w.__guardia);
    registrar('pantalla de bloqueo lista');
    return true;
  });
  ipcMain.handle('lock:desbloquear', async (_e, pass) => {
    if (!activo) return { ok: true };
    const r = await verificar(pass);
    if (r.sinRevisar) { quitarPorFalla(r.error); return { ok: true }; }
    if (!r.ok) { avisar(true, true); anotar('Intento de desbloqueo con contraseña incorrecta'); return r; }
    activo = false;
    registrar('pantalla desbloqueada');
    anotar('Pantalla desbloqueada', r.usuario || '');
    cerrarVentanas();
    avisar(false);
    return { ok: true };
  });
  const rehacer = () => { if (activo) setTimeout(crearVentanas, 500); };
  screen.on('display-added', rehacer);
  screen.on('display-removed', rehacer);
  // Para que la app pueda cerrarse o actualizarse aunque esté bloqueada
  app.on('before-quit', () => { activo = false; cerrarVentanas(); });
}

module.exports = { iniciar, verificar, suPideContrasena, activo: () => activo, _VERIFICADOR: VERIFICADOR };
