const { app, BrowserWindow, ipcMain, shell, Notification } = require('electron');

// Nombre interno de la ventana (WM_CLASS): une la ventana con su ícono en la barra de Ubuntu
app.setName('ghostfish-engine');
if (process.platform === 'linux') app.commandLine.appendSwitch('class', 'ghostfish-engine');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

console.log('[main] cargado desde:', __filename);

// CFG-INICIO
require('./configuracion_main.js');
// CFG-FIN

// TC-INICIO
require('./testcase_main.js');
// TC-FIN



// Recarga automática solo al desarrollar (npm start), nunca en la app instalada
if (!app.isPackaged) {
  try { require('electron-reload')(__dirname); } catch (e) {}
}

// Una sola instancia: si ya está abierta, se trae al frente en vez de abrir otra
// (dos copias duplicaban los pings y se pisaban la configuración)
const esInstanciaPrincipal = app.requestSingleInstanceLock();
if (!esInstanciaPrincipal) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
}

const NOMBRES_SCRIPT = new Set(['connection_validation.py', 'connection_vaidation.py']);
const TIMEOUT_SCRIPT_MS = 3 * 60 * 1000;

const RUTAS_OMITIDAS = ['/proc', '/sys', '/dev', '/run', '/snap', '/boot', '/lost+found', '/var/lib/docker'];
const CARPETAS_OMITIDAS = new Set(['node_modules', '.git', '.cache', '.npm', '__pycache__', 'site-packages']);

/* ============================================================
   PING EN SEGUNDO PLANO (instrumentos)
   Se hace en el proceso principal para que siga funcionando
   aunque la ventana esté minimizada o en otra pestaña.
   ============================================================ */
const IPS_INSTRUMENTOS = ['10.0.0.100', '10.0.0.254', '10.0.0.253','10.254.128.3'];
const INTERVALO_PING_MS = 5000;   // cada cuántos segundos se revisan
const TIMEOUT_PING_MS = 2000;     // espera máxima por respuesta
const REGEX_IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function hacerPing(ip, timeoutMs = TIMEOUT_PING_MS) {
  return new Promise((resolve) => {
    if (!REGEX_IPV4.test(String(ip))) return resolve(false);

    let args;
    if (process.platform === 'win32') {
      args = ['-n', '1', '-w', String(timeoutMs), ip];                          // ms
    } else if (process.platform === 'darwin') {
      args = ['-c', '1', '-W', String(timeoutMs), ip];                          // ms
    } else {
      args = ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip]; // s
    }

    let salida = '';
    let terminado = false;
    let timer = null;
    let proc;

    const fin = (valor) => {
      if (terminado) return;
      terminado = true;
      if (timer) clearTimeout(timer);
      resolve(valor);
    };

    try {
      proc = spawn('ping', args, { windowsHide: true });
    } catch (e) {
      return resolve(false);
    }

    timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      fin(false);
    }, timeoutMs + 2000);

    proc.stdout.on('data', (d) => { salida += d.toString(); });
    proc.on('error', (e) => {
      console.log('[ping] no se pudo ejecutar el comando ping:', e.message);
      fin(false);
    });
    proc.on('close', (code) => {
      // En Windows, "Host de destino inaccesible" devuelve código 0, por eso se exige TTL=
      const respondio = process.platform === 'win32' ? /TTL=/i.test(salida) : true;
      fin(code === 0 && respondio);
    });
  });
}

let estadoInstrumentos = {};   // { '10.0.0.100': { vivo: true, hora: 123456 }, ... }
let cicloEnCurso = false;

function emitirInstrumentos() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('instrumentos-state', estadoInstrumentos);
  }
}

async function cicloPing() {
  if (cicloEnCurso) return;      // evita que se encimen dos rondas
  cicloEnCurso = true;
  try {
    const resultados = await Promise.all(
      IPS_INSTRUMENTOS.map(async (ip) => [ip, await hacerPing(ip)])
    );
    const hora = Date.now();
    const nuevo = { ...estadoInstrumentos };
    for (const [ip, vivo] of resultados) {
      if (!estadoInstrumentos[ip] || estadoInstrumentos[ip].vivo !== vivo) {
        console.log(`[ping] ${ip} -> ${vivo ? 'EN LÍNEA' : 'sin respuesta'}`);
      }
      nuevo[ip] = { vivo, hora };
    }
    estadoInstrumentos = nuevo;
    emitirInstrumentos();
  } finally {
    cicloEnCurso = false;
  }
}

function iniciarMonitorInstrumentos() {
  cicloPing();
  setInterval(cicloPing, INTERVALO_PING_MS);
}

ipcMain.handle('ping-host', (_e, ip) => hacerPing(ip));
ipcMain.handle('get-instrumentos', () => estadoInstrumentos);

/* ============================================================
   BÚSQUEDA Y EJECUCIÓN DEL SCRIPT DE VALIDACIÓN
   ============================================================ */
async function buscarEn(raiz, yaRevisadas) {
  const pila = [raiz];
  while (pila.length) {
    const dir = pila.pop();
    if (RUTAS_OMITIDAS.some((p) => dir === p || dir.startsWith(p + path.sep))) continue;
    if (yaRevisadas.some((p) => dir === p || dir.startsWith(p + path.sep))) continue;
    let entradas;
    try {
      entradas = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entradas) {
      if (e.isFile() && NOMBRES_SCRIPT.has(e.name.toLowerCase())) return path.join(dir, e.name);
    }
    for (const e of entradas) {
      if (e.isDirectory() && !CARPETAS_OMITIDAS.has(e.name)) {
        pila.push(path.join(dir, e.name));
      }
    }
  }
  return null;
}

// Recuerda dónde se encontró el script para no recorrer el disco en cada validación
const rutaCacheScript = () => path.join(app.getPath('userData'), 'script-validacion.json');
function leerCacheScript() {
  try {
    const r = JSON.parse(fs.readFileSync(rutaCacheScript(), 'utf8')).ruta;
    if (r && fs.existsSync(r) && NOMBRES_SCRIPT.has(path.basename(r).toLowerCase())) return r;
  } catch (e) {}
  return null;
}
function guardarCacheScript(r) {
  try { fs.writeFileSync(rutaCacheScript(), JSON.stringify({ ruta: r })); } catch (e) {}
}

async function buscarScriptCompleto() {
  const enCache = leerCacheScript();
  if (enCache) return enCache;
  const encontrado = await buscarScriptEnDisco();
  if (encontrado) guardarCacheScript(encontrado);
  return encontrado;
}

async function buscarScriptEnDisco() {
  const homedir = os.homedir();
  // Instalada desde el menú, la carpeta actual suele ser "/" o la carpeta personal:
  // en ese caso no se usa (si no, se recorría todo el disco antes que el Escritorio)
  const cwd = process.cwd();
  const cwdUtil = cwd !== path.parse(cwd).root && cwd !== homedir;
  const raicesPrioritarias = [
    __dirname,
    ...(cwdUtil ? [cwd] : []),
    path.join(homedir, 'Desktop'),
    path.join(homedir, 'Escritorio'),
    path.join(homedir, 'Documents'),
    path.join(homedir, 'Documentos'),
    path.join(homedir, 'Downloads'),
    path.join(homedir, 'Descargas'),
    homedir
  ];

  const revisadas = [];
  for (const raiz of raicesPrioritarias) {
    if (fs.existsSync(raiz)) {
      if (revisadas.some((p) => raiz === p || raiz.startsWith(p + path.sep))) continue;
      const encontrado = await buscarEn(raiz, revisadas);
      if (encontrado) return encontrado;
      revisadas.push(raiz);
    }
  }

  const raicesGlobales = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':\\').filter((l) => fs.existsSync(l))
    : ['/'];

  for (const raiz of raicesGlobales) {
    if (revisadas.some((p) => raiz === p || raiz.startsWith(p + path.sep))) continue;
    const encontrado = await buscarEn(raiz, revisadas);
    if (encontrado) return encontrado;
    revisadas.push(raiz);
  }

  return null;
}

function ejecutarScript(ruta) {
  return new Promise((resolve) => {
    const comandos = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    let index = 0;

    const intentarEjecucion = () => {
      if (index >= comandos.length) {
        return resolve({ ok: false, salida: '', error: 'No se encontró un intérprete de Python válido.' });
      }

      let terminado = false;
      let salida = '';
      let err = '';
      const proc = spawn(comandos[index], ['-u', ruta], {
        cwd: path.dirname(ruta),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true
      });

      const timer = setTimeout(() => {
        if (!terminado) {
          terminado = true;
          try { proc.kill('SIGKILL'); } catch (e) {}
          resolve({ ok: false, salida, error: 'Tiempo de espera agotado (' + Math.round(TIMEOUT_SCRIPT_MS / 60000) + ' min).' });
        }
      }, TIMEOUT_SCRIPT_MS);

      proc.stdout.on('data', (d) => {
        const texto = d.toString('utf8');
        salida += texto;
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('console-log', texto);
        }
      });

      proc.stderr.on('data', (d) => {
        const texto = d.toString('utf8');
        err += texto;
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('console-log', '[ERR] ' + texto);
        }
      });

      proc.on('error', (e) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(timer);
        if (e.code === 'ENOENT') {
          index++;
          intentarEjecucion();
        } else {
          resolve({ ok: false, salida, error: 'Error al ejecutar: ' + e.message });
        }
      });

      proc.on('close', (code) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(timer);
        resolve({ ok: code === 0 || salida.trim().length > 0, salida, error: err, codigo: code });
      });
    };

    intentarEjecucion();
  });
}

let estadoActual = { fase: 'reposo', salida: '', error: null, ruta: null };

function emitirConsola(texto) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('console-log', texto);
  }
}

function emitirEstado(parcial) {
  estadoActual = { ...estadoActual, ...parcial };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('validation-state', estadoActual);
  }
}

const PASADAS_VALIDACION = 5;   // el script se corre varias veces seguidas: los rectificadores tardan en dejar de detectarse

async function iniciarProcesoValidacion() {
  if (estadoActual.fase === 'buscando' || estadoActual.fase === 'ejecutando') return;   // ya hay una validación en curso
  emitirEstado({ fase: 'buscando', error: null, salida: '', pasada: 0, pasadas: PASADAS_VALIDACION });
  try {
    const ruta = await buscarScriptCompleto();
    if (ruta) emitirConsola('Script: ' + ruta + '\n');
    if (!ruta) {
      emitirEstado({ fase: 'no-encontrado', error: 'No se encontró el archivo connection_validation.py' });
      return;
    }

    let resultado = null;
    for (let i = 1; i <= PASADAS_VALIDACION; i++) {
      emitirEstado({ fase: 'ejecutando', ruta, pasada: i, pasadas: PASADAS_VALIDACION });
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('console-log', (i > 1 ? '\n' : '') + '===== Pasada ' + i + ' de ' + PASADAS_VALIDACION + ' =====\n');
      }
      resultado = await ejecutarScript(ruta);
      if (resultado.codigo !== undefined && resultado.codigo !== 0) {
        emitirConsola('[AVISO] La pasada ' + i + ' terminó con código ' + resultado.codigo + '\n');
      }
      if (!resultado.ok) {
        emitirEstado({ fase: 'error', ruta, salida: resultado.salida, error: 'Pasada ' + i + ' de ' + PASADAS_VALIDACION + ': ' + (resultado.error || 'falló la ejecución'), hora: Date.now() });
        return;
      }
    }

    // El estado final es el de la última pasada (la más reciente)
    emitirEstado({ fase: 'listo', ruta, salida: resultado.salida, error: resultado.error, hora: Date.now(), pasada: PASADAS_VALIDACION });
  } catch (e) {
    emitirEstado({ fase: 'error', error: 'Error inesperado: ' + e.message, hora: Date.now() });
  }
}

// Accesos rápidos a servicios locales: se abren en una pestaña de Chrome
const SITIOS_WEB = {
  opentest: 'http://127.0.0.1:8090/open_test',
  chiller: 'http://127.0.0.1:5000/'
};

function candidatosChrome(url) {
  if (process.platform === 'win32') return [['cmd', ['/c', 'start', '', 'chrome', url]]];
  if (process.platform === 'darwin') return [['open', ['-a', 'Google Chrome', url]]];
  return ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'].map((c) => [c, [url]]);
}

function abrirEnChrome(url) {
  return new Promise((resolve) => {
    const lista = candidatosChrome(url);
    const probar = (i) => {
      if (i >= lista.length) {
        shell.openExternal(url).then(() => resolve({ ok: true, navegador: 'predeterminado' }), (e) => resolve({ ok: false, error: e.message }));
        return;
      }
      let listo = false;
      let p;
      try {
        p = spawn(lista[i][0], lista[i][1], { detached: true, stdio: 'ignore', windowsHide: true });
      } catch (e) { probar(i + 1); return; }
      p.on('error', () => { if (!listo) { listo = true; probar(i + 1); } });
      p.unref();
      setTimeout(() => { if (!listo) { listo = true; resolve({ ok: true, navegador: 'chrome' }); } }, 700);
    };
    probar(0);
  });
}

ipcMain.handle('open-web', (_e, id) => {
  const url = SITIOS_WEB[id];
  if (!url) return { ok: false, error: 'Sitio no válido.' };
  return abrirEnChrome(url);
});

ipcMain.handle('get-estado', () => estadoActual);
ipcMain.handle('run-validation', () => {
  iniciarProcesoValidacion();
  return estadoActual;
});

// Interfaz principal del servidor, en orden de prioridad: eno1 y, si no existe, sfc*
const INTERFACES_PRINCIPALES = [/^eno1$/i, /^sfc/i];
// Para pruebas en otra PC:  INTERFAZ_PRINCIPAL=wlp2s0 npx electron main.js
if (process.env.INTERFAZ_PRINCIPAL) {
  const esc = process.env.INTERFAZ_PRINCIPAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  INTERFACES_PRINCIPALES.unshift(new RegExp('^' + esc + '$', 'i'));
}

ipcMain.handle('get-ips', () => {
  const interfaces = os.networkInterfaces();
  for (const patron of INTERFACES_PRINCIPALES) {
    for (const [nombre, direcciones] of Object.entries(interfaces)) {
      if (!patron.test(nombre)) continue;
      const v4 = (direcciones || []).find((i) => (i.family === 'IPv4' || i.family === 4) && !i.internal);
      if (v4) return [{ nombre, ip: v4.address }];   // solo la principal
    }
  }
  return [];   // si no hay eno1 ni sfc, la interfaz muestra "IP: no disponible"
});

ipcMain.handle('read-dhcp-configs', async () => {
  const rutas = {
    dhcpd: '/etc/dhcp/dhcpd.conf',
    dhcpd6: '/etc/dhcp/dhcpd6.conf'
  };

  const resultados = { dhcpd: '', dhcpd6: '' };

  try {
    if (fs.existsSync(rutas.dhcpd)) {
      resultados.dhcpd = await fs.promises.readFile(rutas.dhcpd, 'utf8');
    } else {
      resultados.dhcpd = '# El archivo /etc/dhcp/dhcpd.conf no existe en este sistema.';
    }
  } catch (e) {
    resultados.dhcpd = `# Error al leer /etc/dhcp/dhcpd.conf:\n# ${e.message}`;
  }

  try {
    if (fs.existsSync(rutas.dhcpd6)) {
      resultados.dhcpd6 = await fs.promises.readFile(rutas.dhcpd6, 'utf8');
    } else {
      resultados.dhcpd6 = '# El archivo /etc/dhcp/dhcpd6.conf no existe en este sistema.';
    }
  } catch (e) {
    resultados.dhcpd6 = `# Error al leer /etc/dhcp/dhcpd6.conf:\n# ${e.message}`;
  }

  return resultados;
});

// Abre dhcpd.conf y dhcpd6.conf con el editor de texto predeterminado del sistema
// cual: 'dhcpd' | 'dhcpd6' para abrir solo uno; sin valor abre los dos
ipcMain.handle('open-dhcp-files', async (_e, cual) => {
  const archivos = { dhcpd: '/etc/dhcp/dhcpd.conf', dhcpd6: '/etc/dhcp/dhcpd6.conf' };
  const resultado = {};
  for (const [clave, ruta] of Object.entries(archivos)) {
    if (cual && cual !== clave) continue;
    if (!fs.existsSync(ruta)) {
      resultado[clave] = { ok: false, ruta, error: 'El archivo no existe en este sistema' };
      continue;
    }
    const err = await shell.openPath(ruta);   // devuelve '' si se abrió bien
    resultado[clave] = err ? { ok: false, ruta, error: err } : { ok: true, ruta };
  }
  return resultado;
});

/* ============================================================
   EJECUCIÓN DE COMANDOS (Actualización de rectificadores)
   - Corre una lista de comandos en orden, en segundo plano.
   - Envía la salida a la ventana en lotes (no satura con salidas enormes).
   - Guarda TODA la salida en un archivo de log.
   ============================================================ */
const FLUSH_SALIDA_MS = 80;      // cada cuánto se envía un lote de líneas a la pantalla
const IDLE_PARCIAL_MS = 400;     // si una línea queda incompleta este tiempo, se muestra igual
const REGEX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

let estadoCmds = {
  fase: 'reposo', total: 0, completados: 0, actual: -1,
  resultados: [], inicio: null, fin: null, logPath: null, error: null
};
let ejecCmds = null;     // { abortado, proc }
let colaSalida = [];
let timerSalida = null;
let logStream = null;

function emitirCmds(parcial) {
  estadoCmds = { ...estadoCmds, ...parcial };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('cmds-state', estadoCmds);
  }
}

function flushSalida() {
  if (timerSalida) { clearTimeout(timerSalida); timerSalida = null; }
  if (!colaSalida.length) return;
  const lote = colaSalida;
  colaSalida = [];
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('cmds-output', lote);
  }
}

function emitirLinea(tipo, texto) {
  colaSalida.push({ t: tipo, s: texto });
  if (logStream) {
    logStream.write((tipo === 'err' ? '[ERR] ' : tipo === 'sys' ? '>>> ' : '') + texto + '\n');
  }
  if (!timerSalida) timerSalida = setTimeout(flushSalida, FLUSH_SALIDA_MS);
}

// Convierte los trozos (chunks) del proceso en líneas completas
function crearLector(tipo) {
  const decoder = new StringDecoder('utf8');
  let resto = '';
  let idle = null;

  const limpiar = (t) => t.replace(REGEX_ANSI, '');
  const vaciarResto = () => {
    const t = resto.replace(/\r$/, '');
    resto = '';
    if (t.length) emitirLinea(tipo, limpiar(t));
  };

  return {
    push(buf) {
      if (idle) { clearTimeout(idle); idle = null; }
      let texto = resto + decoder.write(buf);
      let retenido = '';
      if (texto.endsWith('\r')) { retenido = '\r'; texto = texto.slice(0, -1); } // por si llega \r\n partido
      const partes = texto.split(/\r\n|\n|\r/);
      resto = partes.pop() + retenido;
      for (const linea of partes) emitirLinea(tipo, limpiar(linea));
      if (resto.length) idle = setTimeout(vaciarResto, IDLE_PARCIAL_MS);
    },
    flush() {
      if (idle) { clearTimeout(idle); idle = null; }
      const fin = decoder.end();
      if (fin) resto += fin;
      vaciarResto();
    }
  };
}

function matarArbol(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-proc.pid, 'SIGTERM');
      setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) {} }, 3000);
    }
  } catch (e) {
    try { proc.kill(); } catch (e2) {}
  }
}

function correrComando(cmd) {
  return new Promise((resolve) => {
    const esWin = process.platform === 'win32';
    let terminado = false;
    const fin = (codigo) => { if (!terminado) { terminado = true; resolve(codigo); } };

    let proc;
    try {
      proc = spawn(cmd, {
        shell: true,
        detached: !esWin,                       // grupo propio para poder detener todo el árbol
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],      // sin teclado: los comandos no deben pedir datos
        cwd: os.homedir(),
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb', NO_COLOR: '1' }
      });
    } catch (e) {
      emitirLinea('err', 'No se pudo iniciar: ' + e.message);
      return fin(-1);
    }

    if (ejecCmds) ejecCmds.proc = proc;
    const lectorOut = crearLector('out');
    const lectorErr = crearLector('err');
    proc.stdout.on('data', (d) => lectorOut.push(d));
    proc.stderr.on('data', (d) => lectorErr.push(d));
    proc.on('error', (e) => {
      emitirLinea('err', 'Error: ' + e.message);
      lectorOut.flush(); lectorErr.flush();
      fin(-1);
    });
    proc.on('close', (code) => {
      lectorOut.flush(); lectorErr.flush();
      fin(code === null ? -1 : code);
    });
  });
}

async function ejecutarComandos(lista, detenerSiFalla) {
  const total = lista.length;
  const resultados = lista.map(() => 'pendiente');
  let logPath = null;

  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const sello = new Date().toISOString().replace(/[:.]/g, '-');
    logPath = path.join(dir, `actualizacion_${sello}.log`);
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (e) => console.log('[cmds] no se pudo escribir el log:', e.message));   // disco lleno, etc.: no debe tumbar la app
  } catch (e) {
    logStream = null;
  }

  ejecCmds = { abortado: false, proc: null };
  emitirCmds({
    fase: 'ejecutando', total, completados: 0, actual: 0,
    resultados: [...resultados], inicio: Date.now(), fin: null, error: null, logPath
  });

  let hayFallos = false;
  for (let i = 0; i < total; i++) {
    if (ejecCmds.abortado) break;
    resultados[i] = 'ejecutando';
    emitirCmds({ actual: i, resultados: [...resultados] });
    emitirLinea('sys', `[${i + 1}/${total}] $ ${lista[i]}`);

    const t0 = Date.now();
    const codigo = await correrComando(lista[i]);
    const seg = ((Date.now() - t0) / 1000).toFixed(1);

    if (ejecCmds.abortado) {
      resultados[i] = 'detenido';
      emitirLinea('sys', `[${i + 1}/${total}] DETENIDO · ${seg} s`);
      break;
    }

    const ok = codigo === 0;
    resultados[i] = ok ? 'ok' : 'fallo';
    if (!ok) hayFallos = true;
    emitirLinea('sys', `[${i + 1}/${total}] ${ok ? 'OK' : 'FALLÓ (código ' + codigo + ')'} · ${seg} s`);
    emitirCmds({ completados: i + 1, resultados: [...resultados] });
    if (!ok && detenerSiFalla) break;
  }

  const abortado = ejecCmds.abortado;
  const fase = abortado ? 'detenido' : (hayFallos ? 'error' : 'listo');
  emitirLinea('sys', fase === 'listo' ? 'Proceso completado'
    : fase === 'detenido' ? 'Proceso detenido por el usuario'
    : 'Proceso finalizado con errores');
  flushSalida();
  if (logStream) { logStream.end(); logStream = null; }
  ejecCmds = null;
  emitirCmds({
    fase, resultados: [...resultados], fin: Date.now(),
    error: hayFallos ? 'Uno o más comandos fallaron' : null
  });
}

ipcMain.handle('cmds-run', (_e, datos) => {
  if (ejecCmds) return { ok: false, error: 'Ya hay una ejecución en curso.' };
  const lista = (datos && Array.isArray(datos.comandos) ? datos.comandos : [])
    .map((c) => String(c).trim())
    .filter(Boolean);
  if (!lista.length) return { ok: false, error: 'No hay comandos para ejecutar.' };

  ejecutarComandos(lista, !datos || datos.detenerSiFalla !== false).catch((err) => {
    emitirLinea('err', 'Error interno: ' + err.message);
    flushSalida();
    if (logStream) { logStream.end(); logStream = null; }
    ejecCmds = null;
    emitirCmds({ fase: 'error', error: err.message, fin: Date.now() });
  });
  return { ok: true };
});

ipcMain.handle('cmds-stop', () => {
  if (!ejecCmds) return { ok: false };
  ejecCmds.abortado = true;
  matarArbol(ejecCmds.proc);
  return { ok: true };
});

ipcMain.handle('cmds-state-get', () => estadoCmds);

ipcMain.handle('cmds-open-log', () => {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (estadoCmds.logPath && fs.existsSync(estadoCmds.logPath)) {
    shell.showItemInFolder(estadoCmds.logPath);
  } else {
    shell.openPath(dir);
  }
  return true;
});

console.log('[main] manejadores de comandos registrados (cmds-run, cmds-stop)');

app.on('before-quit', () => {
  if (ejecCmds) { ejecCmds.abortado = true; matarArbol(ejecCmds.proc); }
});

/* ============================================================
   VENTANA
   ============================================================ */
function iconoVentana() {
  try {
    const { nativeImage } = require('electron');
    const dir = path.join(__dirname, 'icons');
    const img = nativeImage.createFromPath(path.join(dir, '48x48.png'));
    if (img.isEmpty()) return path.join(__dirname, 'logo.png');
    const hd = path.join(dir, '96x96.png');
    if (fs.existsSync(hd)) img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(hd) });
    return img;
  } catch (e) {
    return path.join(__dirname, 'logo.png');
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 800,
    minHeight: 520,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: iconoVentana(),   // nítido en la barra de tareas (48 px y 96 px)
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // Los enlaces externos se abren en el navegador, nunca dentro de la app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  if (!esInstanciaPrincipal) return;   // otra copia ya está abierta
  console.log('[main] interfaces de red:',
    Object.entries(os.networkInterfaces())
      .map(([n, d]) => n + '=' + (d || []).filter((i) => i.family === 'IPv4' || i.family === 4).map((i) => i.address).join('/'))
      .join(' | '));
  createWindow();
  iniciarMonitorInstrumentos();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ============================================================
   ACTUALIZACIONES (GitHub Releases)
   Revisa al abrir y cada hora. Avisa con notificación de Ubuntu y dentro de la app.
   Solo funciona en la app instalada (.deb); con "npm start" muestra "modo desarrollo".
   ============================================================ */
let autoUpdater = null;
let versionAvisada = null;
let descargando = false;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.log('[update] electron-updater no instalado: corre "npm install"'); }

function enviarUpdate(estado, datos = {}) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:estado', { estado, ...datos });
  }
}

if (autoUpdater) {
  autoUpdater.autoDownload = false;          // primero se pregunta
  autoUpdater.autoInstallOnAppQuit = true;   // si ya se descargó, se instala al cerrar
  autoUpdater.on('checking-for-update', () => enviarUpdate('buscando'));
  autoUpdater.on('update-not-available', () => enviarUpdate('actual', { version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => {
    enviarUpdate('disponible', { version: info.version });
    if (versionAvisada === info.version) return;   // la notificación de Ubuntu sale una vez por versión, no cada hora
    versionAvisada = info.version;
    if (Notification.isSupported()) {
      new Notification({ title: 'Connection Validation', body: `Nueva versión ${info.version} disponible. Ábrela para actualizar.` }).show();
    }
  });
  autoUpdater.on('download-progress', (p) => enviarUpdate('descargando', { porcentaje: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    enviarUpdate('lista', { version: info.version });
    if (Notification.isSupported()) {
      new Notification({ title: 'Connection Validation', body: `Versión ${info.version} lista. Reinicia la app para instalarla.` }).show();
    }
  });
  autoUpdater.on('error', (e) => enviarUpdate('error', { mensaje: e ? e.message : 'Error desconocido' }));
}

async function buscarActualizaciones() {
  if (!autoUpdater) return enviarUpdate('error', { mensaje: 'Falta el paquete electron-updater. Corre "npm install".' });
  if (!app.isPackaged) return enviarUpdate('dev');
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { enviarUpdate('error', { mensaje: e.message }); }
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:buscar', () => buscarActualizaciones());
ipcMain.handle('update:descargar', async () => {
  if (!autoUpdater || descargando) return;   // evita dos descargas a la vez
  descargando = true;
  try { await autoUpdater.downloadUpdate(); } catch (e) { enviarUpdate('error', { mensaje: e.message }); }
  finally { descargando = false; }
});
ipcMain.handle('update:instalar', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

app.whenReady().then(() => {
  if (!app.isPackaged || !esInstanciaPrincipal) return;
  setTimeout(buscarActualizaciones, 5000);                      // al abrir
  setInterval(buscarActualizaciones, 60 * 60 * 1000);           // y cada hora
});

