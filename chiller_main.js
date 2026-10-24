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
const bitacora = require('./bitacora.js');

const DEVS = {
  chiller_omron: 'CHILLER MONITOR CON OMRON',
  chiller_termopar: 'CHILLER MONITOR CON TERMOPAR'
};
const FLUSH_MS = 80;
const MAX_HIST = 3000;
const RX_PASO = /\[(\d+)\s*\/\s*(\d+)\]\s*(.+?)\s*(?:={2,}|$)/;
const RX_SGR = /\x1b\[([0-9;]*)m/g;
const RX_OTROS_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/* Script interno: va escrito aquí mismo (no es un archivo aparte, así no se puede quedar fuera
   al copiar la app). Es el mismo para los dos chiller. Antes de cada corrida se escribe en la
   carpeta de datos de la app y se corre esa copia.
   Único cambio respecto al original: los scp aceptan la huella del servidor la primera vez
   (StrictHostKeyChecking=accept-new), porque sin terminal nadie puede contestar "yes". */
const SCRIPT_NOMBRE = 'configurar_chiller.sh';
const SCRIPT_CHILLER = [
  "#!/bin/bash",
  "",
  "# ==============================================================================",
  "# SCRIPT DE DESPLIEGUE Y CONFIGURACIÓN: PASS",
  "# Va dentro de Connection Validation (Configuración → CHILLER MONITOR). La app lo corre en segundo plano.",
  "# Cambio para correr sin terminal: scp acepta la huella del servidor la primera vez (StrictHostKeyChecking=accept-new).",
  "# Nivel: Producción / Blindado / Set-and-Forget",
  "# ==============================================================================",
  "",
  "# CONFIGURACIÓN DE COLORES",
  "ROJO='\\033[0;31m'",
  "VERDE='\\033[0;32m'",
  "CYAN='\\033[0;36m'",
  "SIN_COLOR='\\033[0m' # Reset color",
  "",
  "# CREDENCIALES Y RUTAS (Contraseña unificada: 55eed35fba)",
  "MI_PASSWORD=\"55eed35fba\"",
  "RED_PASSWORD=\"55eed35fba\"",
  "ARCHIVO=\"/etc/systemd/system/chillermonitor.service\"",
  "REMOTE_IP=\"172.24.125.166\"",
  "",
  "echo -e \"${CYAN}=== [1/5] Verificando servicio local ===${SIN_COLOR}\"",
  "",
  "# 1. Validación de existencia del archivo de servicio",
  "if [ ! -f \"$ARCHIVO\" ]; then",
  "    echo -e \"${ROJO}[ERROR CRÍTICO] No se encuentra el archivo $ARCHIVO en la ruta especificada.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "",
  "# 2. Candado de idempotencia y modificación segura",
  "if grep -q \"flex_sensor_config.ini\" \"$ARCHIVO\"; then",
  "    echo -e \"${CYAN}[AVISO] El servicio ya cuenta con la configuración aplicada. Omitiendo sed...${SIN_COLOR}\"",
  "else",
  "    echo \"Aplicando modificación en el servicio...\"",
  "    echo \"$MI_PASSWORD\" | sudo -S sed -i '/ExecStart/ { s/^/#/; a ExecStart=/usr/bin/python3 -m stew.services.chiller_monitor.chiller_monitor -c /home/testusr/opentest-google-stew/stew/services/chiller_monitor/config/flex_sensor_config.ini",
  "}' \"$ARCHIVO\"",
  "    ",
  "    if [ $? -ne 0 ]; then",
  "        echo -e \"${ROJO}[ERROR] Falló la modificación del archivo con sed.${SIN_COLOR}\"",
  "        read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "        exit 1",
  "    fi",
  "    echo -e \"${VERDE}[OK] Línea comentada y servicio configurado con éxito.${SIN_COLOR}\"",
  "fi",
  "",
  "# 3. Descarga vía SCP con validación de error",
  "echo -e \"\\n${CYAN}=== [2/5] Descargando archivos remotos vía SCP ===${SIN_COLOR}\"",
  "",
  "sshpass -p \"$RED_PASSWORD\" scp -o StrictHostKeyChecking=accept-new \"$REMOTE_IP:/home/testusr/opentest-google-stew/stew/services/chiller_monitor/module/data_logging.py\" .",
  "if [ $? -ne 0 ]; then",
  "    echo -e \"${ROJO}[ERROR] Falló la descarga remota de 'data_logging.py' via SCP.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "",
  "sshpass -p \"$RED_PASSWORD\" scp -o StrictHostKeyChecking=accept-new \"$REMOTE_IP:/home/testusr/opentest-google-stew/stew/services/chiller_monitor/config/flex_sensor_config.ini\" .",
  "if [ $? -ne 0 ]; then",
  "    echo -e \"${ROJO}[ERROR] Falló la descarga remota de 'flex_sensor_config.ini' via SCP.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "echo -e \"${VERDE}[OK] Archivos descargados correctamente.${SIN_COLOR}\"",
  "",
  "# 4. Mover archivos con sudo y validación",
  "echo -e \"\\n${CYAN}=== [3/5] Moviendo archivos a directorios del sistema ===${SIN_COLOR}\"",
  "",
  "echo \"$MI_PASSWORD\" | sudo -S mv data_logging.py /home/testusr/opentest-google-stew/stew/services/chiller_monitor/module/",
  "if [ $? -ne 0 ]; then",
  "    echo -e \"${ROJO}[ERROR] No se pudo mover 'data_logging.py' a su ruta final.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "",
  "echo \"$MI_PASSWORD\" | sudo -S mv flex_sensor_config.ini /home/testusr/opentest-google-stew/stew/services/chiller_monitor/config/",
  "if [ $? -ne 0 ]; then",
  "    echo -e \"${ROJO}[ERROR] No se pudo mover 'flex_sensor_config.ini' a su ruta final.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "echo -e \"${VERDE}[OK] Archivos reubicados con éxito.${SIN_COLOR}\"",
  "",
  "# 5. Recarga de Systemd y reinicio con validación",
  "echo -e \"\\n${CYAN}=== [4/5] Aplicando cambios en Systemd y reiniciando servicio ===${SIN_COLOR}\"",
  "",
  "echo \"$MI_PASSWORD\" | sudo -S systemctl daemon-reload",
  "if [ $? -ne 0 ]; then",
  "    echo -e \"${ROJO}[ERROR] Falló el comando daemon-reload.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "",
  "echo \"$MI_PASSWORD\" | sudo -S systemctl restart chillermonitor.service",
  "if [ $? -ne 0 ]; then",
  "    echo -e \"${ROJO}[ERROR] El servicio chillermonitor.service falló al reiniciar.${SIN_COLOR}\"",
  "    read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "    exit 1",
  "fi",
  "echo -e \"${VERDE}[OK] Servicio reiniciado correctamente.${SIN_COLOR}\"",
  "",
  "# 6. Lanzamiento de navegadores",
  "echo -e \"\\n${CYAN}=== [5/5] Abriendo dashboards en Google Chrome ===${SIN_COLOR}\"",
  "google-chrome 127.0.0.1:8090/open_test &>/dev/null &",
  "google-chrome 127.0.0.1:5000 &>/dev/null &",
  "google-chrome 10.0.0.100 &>/dev/null &",
  "echo -e \"${VERDE}[OK] Dashboards lanzados.${SIN_COLOR}\"",
  "",
  "# ==============================================================================",
  "# LOGO FINAL: PASS (EN VERDE) + ARTE KAOMOJI",
  "# ==============================================================================",
  "echo -e \"\\n${VERDE}\"",
  "echo \"  ____  _    ____ ____  \"",
  "echo \" |  _ \\/ \\  / ___/ ___| \"",
  "echo \" | |_) / _ \\ \\___ \\___ \\ \"",
  "echo \" |  __/ ___ \\ ___) |__) |\"",
  "echo \" |_| /_/   \\_\\____/____/ \"",
  "echo -e \"${SIN_COLOR}\"",
  "",
  "echo -e \"${CYAN}\"",
  "echo \"            C· プ°\"",
  "echo \"           \\\\ (  )\"",
  "echo \"             \\\\ \\\\\"",
  "echo -e \"${SIN_COLOR}\"",
  "",
  "echo -e \"${VERDE}==============================================================================\"",
  "echo \"         ¡TODO EL DESPLIEGUE FINALIZÓ CON ÉXITO Y SIN ERRORES!                \"",
  "echo \"==============================================================================${SIN_COLOR}\"",
  "",
  "# Pausa final para que el usuario presione una tecla antes de cerrar",
  "echo -e \"\\n\"",
  "read -p \"Presiona cualquier tecla para salir...\" -n1 -s",
  "echo -e \"\\n\""
].join('\n') + '\n';
function prepararScript() {
  const destino = path.join(app.getPath('userData'), 'chiller', SCRIPT_NOMBRE);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, SCRIPT_CHILLER);
  fs.chmodSync(destino, 0o755);
  return destino;
}
// Una línea con [ERROR …] cuenta como error aunque el script termine con código 0
const RX_ERROR = /\[ERROR|ERROR CR[IÍ]TICO|command not found|Permission denied|Host key verification failed/i;

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
  try { return pasosDeTexto(fs.readFileSync(ruta, 'utf8')); } catch (e) { return []; }
}
function pasosDeTexto(txt) {
  try {
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
  const pasos = pasosDeTexto(SCRIPT_CHILLER);
  for (const dev of Object.keys(DEVS)) scripts[dev] = { ruta: SCRIPT_NOMBRE, interno: true, existe: true, pasos };
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
  if (RX_ERROR.test(limpio)) { t.errores = (t.errores || 0) + 1; if (!tipo || tipo === 'out') tipo = 'err'; }
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
  let ruta;
  try { ruta = prepararScript(); } catch (e) { return { ok: false, error: 'No se pudo preparar el script: ' + e.message }; }

  const dir = path.join(app.getPath('userData'), 'chiller', dev);      // ahí caen los scp con "."
  const dirLogs = bitacora.dir('chiller');
  try { fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(dirLogs, { recursive: true }); } catch (e) {}
  const log = path.join(dirLogs, dev + '_' + sello() + '.log');
  let logStream = null;
  try { logStream = fs.createWriteStream(log, { flags: 'a' }); logStream.on('error', () => {}); } catch (e) {}

  const t = { dev, inicio: Date.now(), proc: null, unidad: null, log, logStream, abort: false, color: null, paso: 0, errores: 0, total: pasosDe(ruta).length ? pasosDe(ruta)[0].total : 0 };
  trabajo = t;
  bitacora.registrar('Chiller', 'Corrió script', DEVS[dev] + ' · ' + ruta);
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
  const configurado = !t.abort && codigo === 0 && !t.errores;
  if (t.abort) linea(dev, 'warn', '■ Detenido por el usuario · ' + dur + ' · no quedó configurado');
  else if (configurado) linea(dev, 'ok', '✓ CONFIGURADO · terminó sin errores · ' + dur);
  else if (codigo === 0) linea(dev, 'err', '✕ NO QUEDÓ CONFIGURADO · el script mostró ' + t.errores + ' error(es) · ' + dur);
  else linea(dev, 'err', '✕ NO QUEDÓ CONFIGURADO · el script terminó con código ' + codigo + ' · ' + dur);
  vaciar();
  try { if (logStream) logStream.end(); } catch (e) {}

  const c = cargar();
  bitacora.registrar('Chiller', t.abort ? 'Configuración detenida' : configurado ? 'Configurado' : 'No quedó configurado', DEVS[dev] + ' · código ' + codigo + ' · ' + t.errores + ' error(es) · ' + dur + ' · ' + log);
  c.ultimo[dev] = { codigo: t.abort ? null : codigo, detenido: !!t.abort, errores: t.errores, configurado, fin: Date.now(), paso: t.paso, total: t.total, tituloPaso: t.tituloPaso || '', log };
  guardar();
  trabajo = null;
  emitirEstado();
  return { ok: configurado, codigo };
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
  shell.openPath(bitacora.dir('chiller'));
  return true;
});

module.exports = { configurar, detener, ocupado: () => !!trabajo };
