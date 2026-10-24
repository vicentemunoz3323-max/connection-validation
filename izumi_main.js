'use strict';
/* ============================================================
   CONSOLA DE IZUMI (proceso principal)
   - Al dar clic en una Izumi se abre su propia ventana "Izumi N".
   - Se conecta por telnet al ZPE: 10.0.0.253, puerto 7000 + N.
   - La salida se manda a la ventana en lotes (aguanta horas de texto rápido).
   - TODO lo que manda la Izumi se guarda en un log, aunque la pantalla se limpie.
   Se carga desde main.js con:  require('./izumi_main.js');
   ============================================================ */
const { app, ipcMain, BrowserWindow, dialog, shell, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { StringDecoder } = require('string_decoder');

// Mismos datos del ZPE que usa "Generar Test case" (un solo lugar para cambiarlos)
let ZPE = { ZPE_IP: '10.0.0.253', ZPE_PUERTO_BASE: 7000 };
try { ZPE = { ...ZPE, ...(require('./testcase_main.js').CONFIG || {}) }; } catch (e) {}

const NUM_IZUMIS = 16;
const FLUSH_MS = 33;                     // cada cuánto se manda un lote a la pantalla (~30 por segundo)
const MAX_PENDIENTE = 4 * 1024 * 1024;   // si la pantalla se atrasa más de 4 MB, se salta (el log guarda todo)
const TIMEOUT_CONEXION_MS = 6000;
const REINTENTO_MS = 3000;
const REGEX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g;
const REGEX_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;   // deja \t \n \r

const dos = (n) => String(n).padStart(2, '0');
const horaTxt = (d = new Date()) => dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds());
const fechaTxt = (d = new Date()) => d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' + horaTxt(d);

const sesiones = new Map();   // n -> sesión

/* ---------- Aviso a la ventana principal: qué consolas están abiertas ---------- */
function resumenSesiones() {
  const r = {};
  for (const [n, s] of sesiones) r[n] = s.estado;
  return r;
}
function avisarPrincipal() {
  const r = resumenSesiones();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.__izumi) w.webContents.send('izumi-sesiones', r);
  }
}

/* ---------- Envío a la ventana de la consola ---------- */
function enviarVentana(s, canal, datos) {
  if (s.win && !s.win.isDestroyed()) s.win.webContents.send(canal, datos);
}

function infoEstado(s) {
  return {
    n: s.n, host: ZPE.ZPE_IP, puerto: s.puerto, estado: s.estado, motivo: s.motivo || '',
    desde: s.desde || null, log: s.log, bytes: s.bytes, auto: s.auto, reintento: !!s.timerReintento
  };
}
function cambiarEstado(s, estado, motivo) {
  s.estado = estado;
  s.motivo = motivo || '';
  enviarVentana(s, 'izu:estado', infoEstado(s));
  avisarPrincipal();
}

function flush(s) {
  if (s.timerFlush) { clearTimeout(s.timerFlush); s.timerFlush = null; }
  if (!s.cola.length) return;
  let texto = s.cola.join('');
  s.cola = [];
  s.colaBytes = 0;
  enviarVentana(s, 'izu:datos', texto);
}

// Todo lo que se ve en pantalla pasa por aquí: se guarda en el log y se encola para la ventana
function emitir(s, texto) {
  if (!texto) return;
  if (s.logStream) s.logStream.write(texto.replace(/\r\n/g, '\n'));
  s.cola.push(texto);
  s.colaBytes += texto.length;
  if (s.colaBytes > MAX_PENDIENTE) {
    // La ventana no alcanza a pintar: se deja solo lo más reciente en pantalla
    const junto = s.cola.join('');
    const omitido = junto.length - MAX_PENDIENTE / 2;
    s.cola = ['\n[… se omitieron ' + Math.round(omitido / 1024) + ' KB en pantalla; están completos en el log …]\n', junto.slice(omitido)];
    s.colaBytes = MAX_PENDIENTE / 2;
  }
  if (!s.timerFlush) s.timerFlush = setTimeout(() => flush(s), FLUSH_MS);
}
function aviso(s, texto) {
  emitir(s, '\n──── ' + texto + ' · ' + horaTxt() + ' ────\n');
}

/* ---------- Log ---------- */
function abrirLog(s) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs', 'izumi');
    fs.mkdirSync(dir, { recursive: true });
    const sello = fechaTxt().replace(/[: ]/g, '-');
    s.log = path.join(dir, 'izumi-' + dos(s.n) + '_' + sello + '.log');
    s.logStream = fs.createWriteStream(s.log, { flags: 'a' });
    s.logStream.on('error', (e) => console.log('[izumi] no se pudo escribir el log:', e.message));
    s.logStream.write('# Consola Izumi ' + s.n + ' · ' + ZPE.ZPE_IP + ':' + s.puerto + ' · ' + fechaTxt() + '\n');
  } catch (e) {
    s.log = null;
    s.logStream = null;
  }
}

/* ---------- Telnet ---------- */
// Quita los comandos telnet (IAC) del flujo y responde la negociación como un cliente telnet normal
function procesarTelnet(s, buf) {
  const datos = [];
  for (const b of buf) {
    const t = s.tn;
    if (t.modo === 'dato') {
      if (b === 255) t.modo = 'iac'; else datos.push(b);
    } else if (t.modo === 'iac') {
      if (b === 255) { datos.push(255); t.modo = 'dato'; }
      else if (b >= 251 && b <= 254) { t.cmd = b; t.modo = 'opcion'; }
      else if (b === 250) t.modo = 'sb';
      else t.modo = 'dato';                       // NOP, GA, etc.
    } else if (t.modo === 'opcion') {
      responderOpcion(s, t.cmd, b);
      t.modo = 'dato';
    } else if (t.modo === 'sb') {
      if (b === 255) t.modo = 'sbiac';
    } else if (t.modo === 'sbiac') {
      t.modo = b === 240 ? 'dato' : 'sb';
    }
  }
  return Buffer.from(datos);
}
function responderOpcion(s, cmd, opt) {
  const clave = cmd + ':' + opt;
  if (s.tn.respondidas.has(clave)) return;       // evita ciclos de negociación
  s.tn.respondidas.add(clave);
  let r = null;
  if (cmd === 251) r = (opt === 1 || opt === 3) ? 253 : 254;   // WILL eco / SGA -> DO; lo demás -> DONT
  else if (cmd === 253) r = opt === 3 ? 251 : 252;             // DO SGA -> WILL; lo demás -> WONT
  if (r !== null && s.sock && !s.sock.destroyed) s.sock.write(Buffer.from([255, r, opt]));
}

function limpiarTimers(s) {
  if (s.timerReintento) { clearTimeout(s.timerReintento); s.timerReintento = null; }
  if (s.timerConexion) { clearTimeout(s.timerConexion); s.timerConexion = null; }
}

function motivoError(e, puerto) {
  const c = e && e.code;
  if (c === 'ECONNREFUSED') return 'El ZPE rechazó la conexión (¿otra sesión usa el puerto ' + puerto + '?)';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'No se llega a ' + ZPE.ZPE_IP + ' (revisa el cable o la red)';
  if (c === 'ETIMEDOUT') return 'Sin respuesta de ' + ZPE.ZPE_IP;
  if (c === 'ECONNRESET') return 'El ZPE cerró la conexión';
  return e ? e.message : 'Error desconocido';
}

function conectar(s) {
  limpiarTimers(s);
  if (s.sock) { s.sock.removeAllListeners(); s.sock.destroy(); s.sock = null; }
  s.manual = false;
  s.tn = { modo: 'dato', cmd: 0, respondidas: new Set() };
  s.decoder = new StringDecoder('utf8');
  cambiarEstado(s, 'conectando', 'Conectando a ' + ZPE.ZPE_IP + ':' + s.puerto + '…');

  const sock = net.connect({ host: ZPE.ZPE_IP, port: s.puerto });
  s.sock = sock;
  let conectado = false;

  s.timerConexion = setTimeout(() => {
    if (!conectado) sock.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
  }, TIMEOUT_CONEXION_MS);

  sock.on('connect', () => {
    conectado = true;
    clearTimeout(s.timerConexion); s.timerConexion = null;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10000);
    s.desde = Date.now();
    s.fallos = 0;
    aviso(s, 'Conectado a ' + ZPE.ZPE_IP + ':' + s.puerto);
    cambiarEstado(s, 'conectado', '');
  });

  sock.on('data', (buf) => {
    const limpio = procesarTelnet(s, buf);
    if (!limpio.length) return;
    s.bytes += limpio.length;
    const texto = s.decoder.write(limpio).replace(REGEX_ANSI, '').replace(REGEX_CONTROL, '');
    emitir(s, texto);
  });

  sock.on('error', (e) => { s.ultimoError = e; });

  sock.on('close', () => {
    if (s.sock !== sock) return;                 // ya se reemplazó por una conexión nueva
    clearTimeout(s.timerConexion); s.timerConexion = null;
    s.sock = null;
    const resto = s.decoder ? s.decoder.end() : '';
    if (resto) emitir(s, resto);
    if (s.cerrando) return;
    const motivo = s.manual ? 'Desconectado por el usuario'
      : conectado ? 'Se perdió la conexión'
      : motivoError(s.ultimoError, s.puerto);
    s.ultimoError = null;
    if (conectado || s.manual || !s.fallos) aviso(s, motivo);   // los reintentos fallidos no llenan el log
    s.desde = null;
    if (!s.manual && s.auto) {
      s.fallos = (s.fallos || 0) + 1;
      s.timerReintento = setTimeout(() => { s.timerReintento = null; conectar(s); }, REINTENTO_MS);
      cambiarEstado(s, 'desconectado', motivo + ' · reintentando en ' + REINTENTO_MS / 1000 + ' s');
    } else {
      cambiarEstado(s, 'desconectado', motivo);
    }
    flush(s);
  });
}

function desconectar(s) {
  limpiarTimers(s);
  s.manual = true;
  if (s.sock) s.sock.destroy();
  else cambiarEstado(s, 'desconectado', 'Desconectado por el usuario');
}

function enviarTexto(s, texto, fin) {
  if (!s.sock || s.estado !== 'conectado') return { ok: false, error: 'No hay conexión con la Izumi.' };
  const finales = { crlf: '\r\n', cr: '\r', lf: '\n', nada: '' };
  const buf = Buffer.from(String(texto) + (finales[fin] !== undefined ? finales[fin] : '\r\n'), 'utf8');
  // En telnet el byte 255 se manda doble
  const salida = [];
  for (const b of buf) { salida.push(b); if (b === 255) salida.push(255); }
  s.sock.write(Buffer.from(salida));
  return { ok: true };
}

/* ---------- Ventana de cada Izumi ---------- */
function iconoVentana() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icons', '48x48.png'));
    const hd = path.join(__dirname, 'icons', '96x96.png');
    if (!img.isEmpty() && fs.existsSync(hd)) img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(hd) });
    return img.isEmpty() ? undefined : img;
  } catch (e) { return undefined; }
}

function abrirConsola(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 1 || n > NUM_IZUMIS) return { ok: false, error: 'Izumi no válida.' };

  const existente = sesiones.get(n);
  if (existente && existente.win && !existente.win.isDestroyed()) {
    if (existente.win.isMinimized()) existente.win.restore();
    existente.win.show();
    existente.win.focus();
    if (existente.estado === 'desconectado' && !existente.timerReintento) conectar(existente);
    return { ok: true, yaAbierta: true };
  }

  const s = {
    n, puerto: ZPE.ZPE_PUERTO_BASE + n, win: null, sock: null, estado: 'conectando', motivo: '',
    cola: [], colaBytes: 0, timerFlush: null, bytes: 0, desde: null, auto: true,
    log: null, logStream: null, manual: false, cerrando: false, fallos: 0
  };
  sesiones.set(n, s);
  abrirLog(s);

  const win = new BrowserWindow({
    width: 1040, height: 700, minWidth: 640, minHeight: 420,
    title: 'Izumi ' + n,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    icon: iconoVentana(),
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,     // sigue pintando aunque la ventana esté atrás
      preload: path.join(__dirname, 'izumi_preload.js')
    }
  });
  win.__izumi = n;
  s.win = win;
  win.on('page-title-updated', (e) => e.preventDefault());   // el título siempre es "Izumi N"
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.once('did-finish-load', () => conectar(s));
  win.on('closed', () => cerrarSesion(n));
  win.loadFile(path.join(__dirname, 'izumi.html'), { query: { n: String(n) } });
  avisarPrincipal();
  return { ok: true };
}

function cerrarSesion(n) {
  const s = sesiones.get(n);
  if (!s) return;
  s.cerrando = true;
  limpiarTimers(s);
  if (s.timerFlush) clearTimeout(s.timerFlush);
  if (s.sock) { s.sock.removeAllListeners(); s.sock.destroy(); s.sock = null; }
  if (s.logStream) {
    s.logStream.write('\n# Consola cerrada · ' + fechaTxt() + '\n');
    s.logStream.end();
    s.logStream = null;
  }
  s.win = null;
  sesiones.delete(n);
  avisarPrincipal();
}

function sesionDe(sender) {
  for (const s of sesiones.values()) if (s.win && !s.win.isDestroyed() && s.win.webContents === sender) return s;
  return null;
}

/* ---------- Canales ---------- */
ipcMain.handle('izu:abrir', (_e, n) => abrirConsola(n));
ipcMain.handle('izu:sesiones', () => resumenSesiones());

ipcMain.handle('izu:info', (e) => { const s = sesionDe(e.sender); return s ? infoEstado(s) : null; });
ipcMain.handle('izu:reconectar', (e) => { const s = sesionDe(e.sender); if (s) conectar(s); return !!s; });
ipcMain.handle('izu:desconectar', (e) => { const s = sesionDe(e.sender); if (s) desconectar(s); return !!s; });
ipcMain.handle('izu:auto', (e, on) => { const s = sesionDe(e.sender); if (s) { s.auto = !!on; if (!on) limpiarTimers(s); enviarVentana(s, 'izu:estado', infoEstado(s)); } return !!s; });
ipcMain.handle('izu:enviar', (e, texto, fin) => { const s = sesionDe(e.sender); return s ? enviarTexto(s, texto, fin) : { ok: false }; });

ipcMain.handle('izu:guardar-como', async (e) => {
  const s = sesionDe(e.sender);
  if (!s || !s.log) return { ok: false, error: 'No hay log para guardar.' };
  const r = await dialog.showSaveDialog(s.win, {
    title: 'Guardar log de Izumi ' + s.n,
    defaultPath: path.join(app.getPath('documents') || os.homedir(), path.basename(s.log)),
    filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
  });
  if (r.canceled || !r.filePath) return { ok: true, cancelado: true };
  try {
    await new Promise((res) => (s.logStream ? s.logStream.write('', res) : res()));   // asegura que lo pendiente ya esté en disco
    await fs.promises.copyFile(s.log, r.filePath);
    return { ok: true, ruta: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('izu:carpeta-logs', (e) => {
  const s = sesionDe(e.sender);
  if (s && s.log && fs.existsSync(s.log)) shell.showItemInFolder(s.log);
  else {
    const dir = path.join(app.getPath('userData'), 'logs', 'izumi');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  }
  return true;
});

// Cierra las consolas cuando se cierra la ventana principal o la app
function cerrarTodas() {
  for (const s of [...sesiones.values()]) {
    if (s.win && !s.win.isDestroyed()) s.win.close();
    else cerrarSesion(s.n);
  }
}
app.on('before-quit', () => { for (const n of [...sesiones.keys()]) cerrarSesion(n); });

module.exports = { cerrarTodas, abierta: (n) => sesiones.has(Number(n)) };
console.log('[izumi] módulo de consola Izumi cargado');
