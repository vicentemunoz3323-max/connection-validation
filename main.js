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

// Bitácora central: todos los logs en ~/Ghostfish-Logs (una carpeta por sección)
const bitacora = require('./bitacora.js');

// CFG-INICIO
require('./configuracion_main.js');
// CFG-FIN

// TC-INICIO
require('./testcase_main.js');
// TC-FIN

// Consolas telnet de las Izumi (una ventana por Izumi)
const consolasIzumi = require('./izumi_main.js');

// Remplazar Izumi: lee las MAC actuales de dhcpd.conf y las remplaza
const remplazoIzumi = require('./remplazo_main.js');
// Chiller monitor: scripts bash en segundo plano con salida en la app
const chillerMonitor = require('./chiller_main.js');
// Configuración del servidor: gf_provisioning.py parchado, con pasos y preguntas en la app
const servidor = require('./server_main.js');
require('./llave_main.js');   // llave USB con las contraseñas
// Revisión de Izumis por telnet (independiente del script de los rectificadores)
const revisionIzumis = require('./izumi_check.js');
revisionIzumis.configurar({
  consolaAbierta: (n) => consolasIzumi.abierta(n),
  escaneando: () => { try { return require('./testcase_main.js').escaneando(); } catch (e) { return false; } }
});



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
    const w = ventanaPrincipal && !ventanaPrincipal.isDestroyed() ? ventanaPrincipal : BrowserWindow.getAllWindows()[0];
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
        escribirLogValidacion(texto);
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('console-log', texto);
        }
      });

      proc.stderr.on('data', (d) => {
        const texto = d.toString('utf8');
        err += texto;
        escribirLogValidacion('[ERR] ' + texto);
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

// Log de la validación en ~/Ghostfish-Logs/validacion (una corrida = un archivo)
let logValidacion = null;
function escribirLogValidacion(t) { if (logValidacion) { try { logValidacion.write(t); } catch (e) {} } }
function abrirLogValidacion() {
  cerrarLogValidacion();
  try {
    logValidacion = require('fs').createWriteStream(path.join(bitacora.dir('validacion'), 'validacion_' + bitacora.sello() + '.log'), { flags: 'a' });
    logValidacion.on('error', () => {});
    logValidacion.write('# Probar conexión · ' + bitacora.fecha() + ' ' + bitacora.hora() + '\n\n');
  } catch (e) { logValidacion = null; }
}
function cerrarLogValidacion(final) {
  if (!logValidacion) return;
  try { if (final) logValidacion.write('\n# ' + final + ' · ' + bitacora.hora() + '\n'); logValidacion.end(); } catch (e) {}
  logValidacion = null;
}

function emitirConsola(texto) {
  escribirLogValidacion(texto);
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
  // Las Izumis se revisan por su cuenta, en paralelo (telnet al ZPE); no esperan al script
  revisionIzumis.revisarTodas((t) => emitirConsola('[Izumis] ' + t)).catch((e) => emitirConsola('[Izumis] Error: ' + e.message + '\n'));
  abrirLogValidacion();
  bitacora.registrar('Validación', 'Probar conexión', PASADAS_VALIDACION + ' pasadas del script + revisión de Izumis');
  emitirEstado({ fase: 'buscando', error: null, salida: '', pasada: 0, pasadas: PASADAS_VALIDACION });
  try {
    const ruta = await buscarScriptCompleto();
    if (ruta) emitirConsola('Script: ' + ruta + '\n');
    if (!ruta) {
      emitirEstado({ fase: 'no-encontrado', error: 'No se encontró el archivo connection_validation.py' });
      bitacora.registrar('Validación', 'Script no encontrado', 'connection_validation.py');
      cerrarLogValidacion('Script no encontrado');
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
        bitacora.registrar('Validación', 'Falló', 'Pasada ' + i + ': ' + String(resultado.error || '').slice(0, 300));
        cerrarLogValidacion('Falló en la pasada ' + i);
        return;
      }
    }

    // El estado final es el de la última pasada (la más reciente)
    emitirEstado({ fase: 'listo', ruta, salida: resultado.salida, error: resultado.error, hora: Date.now(), pasada: PASADAS_VALIDACION });
    bitacora.registrar('Validación', 'Terminó', PASADAS_VALIDACION + ' pasadas · ' + ruta);
    cerrarLogValidacion('Terminó');
  } catch (e) {
    emitirEstado({ fase: 'error', error: 'Error inesperado: ' + e.message, hora: Date.now() });
    bitacora.registrar('Validación', 'Error inesperado', e.message);
    cerrarLogValidacion('Error: ' + e.message);
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
    bitacora.registrar('Files DHCP', 'Abrió archivo', ruta + (err ? ' (error: ' + err + ')' : ''));
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
  if ((estadoCmds.pide || estadoCmds.progreso) && tipo !== 'sys') emitirCmds({ pide: null, progreso: null });   // llegó salida nueva: ya no está esperando
  colaSalida.push({ t: tipo, s: texto });
  if (logStream) {
    logStream.write((tipo === 'err' ? '[ERR] ' : tipo === 'sys' ? '>>> ' : '') + texto + '\n');
  }
  if (!timerSalida) timerSalida = setTimeout(flushSalida, FLUSH_SALIDA_MS);
}

// Convierte los trozos (chunks) del proceso en líneas completas.
// alPausar(texto): se llama cuando una línea se queda sin terminar (así se ven las preguntas
// tipo "[sudo] password for …:" o "¿Continuar? [S/n]").
// alProgreso(texto): barras de progreso que se reescriben con \r (scp, rsync, apt): no llenan la consola,
// se muestran en una sola línea de estado y solo queda en la consola el resultado final.
const ultimoSegmento = (l) => { const i = l.lastIndexOf('\r'); return i >= 0 ? l.slice(i + 1) : l; };

function crearLector(tipo, alPausar, alProgreso) {
  const decoder = new StringDecoder('utf8');
  let resto = '';
  let idle = null;
  let esProgreso = false;
  let ultimoProg = 0;

  const limpiar = (t) => t.replace(REGEX_ANSI, '');
  const vaciarResto = (porPausa) => {
    const t = resto.replace(/\r$/, '');
    if (!t.length) { resto = ''; return; }
    const linea = limpiar(t);
    if (porPausa && esProgreso && !analizarPregunta(linea)) {
      if (alProgreso) alProgreso(linea);   // sigue en curso: se queda pendiente hasta el salto de línea
      return;
    }
    resto = '';
    esProgreso = false;
    emitirLinea(tipo, linea);
    if (porPausa && alPausar) alPausar(linea);
  };

  return {
    push(buf) {
      if (idle) { clearTimeout(idle); idle = null; }
      let texto = resto + decoder.write(buf);
      let retenido = '';
      if (texto.endsWith('\r')) { retenido = '\r'; texto = texto.slice(0, -1); } // por si llega \r\n partido
      const partes = texto.split(/\r?\n/);
      resto = partes.pop();
      for (const linea of partes) emitirLinea(tipo, limpiar(ultimoSegmento(linea)));
      if (partes.length) esProgreso = false;
      const k = resto.lastIndexOf('\r');
      if (k >= 0) { resto = resto.slice(k + 1); esProgreso = true; }   // se reescribió la línea: solo cuenta lo último
      resto += retenido;
      if (esProgreso && alProgreso && resto.trim() && Date.now() - ultimoProg > 700) {
        ultimoProg = Date.now();
        alProgreso(limpiar(resto.replace(/\r$/, '')));
      }
      if (resto.length) idle = setTimeout(() => vaciarResto(true), IDLE_PARCIAL_MS);
    },
    flush() {
      if (idle) { clearTimeout(idle); idle = null; }
      const fin = decoder.end();
      if (fin) resto += fin;
      esProgreso = false;
      vaciarResto(false);
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

/* ---------- Terminal real para cada comando ----------
   Se usa "script" (viene en Ubuntu) para darle a cada comando una terminal (pty).
   Así sudo, ssh y cualquier programa que pida contraseña o confirmación funcionan:
   la app detecta la pregunta y te deja contestarla. */
const SCRIPT_PTY = process.platform === 'linux' && fs.existsSync('/usr/bin/script') ? '/usr/bin/script' : null;
const RX_PIDE_PASS = /(password|contraseña|passphrase|clave|pin)\b[^\n]*[:：]\s*$/i;
const RX_PIDE_SUDO = /\[sudo\]|sudo\b.*(password|contraseña)|password for \S+:\s*$|contraseña para \S+:\s*$/i;
const RX_PIDE_SINO = /(\[[ysSnN]\/[ysSnN]\]|\((yes|no|si|sí)\/(no|yes)[^)]*\)|\[(Y|S)\/n\]|\[y\/N\]|continue\?|continuar\?|\?\s*$|:\s*$)/i;
// Contraseñas recordadas (solo en memoria, se borran al cerrar la app).
// Clave: "sudo" para sudo, y el texto de la pregunta para lo demás (p. ej. "serverus@10.0.0.5's password:"),
// así cada rack/usuario tiene la suya.
const guardadas = new Map();
const claveDe = (p) => (p.sudo ? 'sudo' : p.texto.trim().replace(/\s+/g, ' '));
const etiquetaDe = (clave) => (clave === 'sudo' ? 'sudo' : clave.replace(/[:：]\s*$/, ''));
const RX_PASS_MALA = /permission denied|sorry, try again|incorrect password|authentication fail|contraseña incorrecta|wrong password|access denied|login incorrect|bad passphrase/i;

/* ---------- "no new privileges" ----------
   Si la app se abrió desde un programa que activa esta protección (por ejemplo VS Code
   instalado como Flatpak/Snap, o algunos lanzadores), sudo no puede subir a root en ningún
   proceso hijo. En ese caso cada comando se lanza con "systemd-run --user", que corre fuera
   de la app (en tu sesión de Ubuntu) y ahí sudo sí funciona. */
function tieneNoNewPrivs() {
  try { return /NoNewPrivs:\s*1/.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch (e) { return false; }
}
const NO_NEW_PRIVS = process.platform === 'linux' && tieneNoNewPrivs();
const SYSTEMD_RUN = process.env.CV_SYSTEMD_RUN || (fs.existsSync('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : null);
let systemdRunOk = null;   // se prueba una sola vez

function probarSystemdRun() {
  if (systemdRunOk !== null) return Promise.resolve(systemdRunOk);
  if (!NO_NEW_PRIVS || !SYSTEMD_RUN) { systemdRunOk = false; return Promise.resolve(false); }
  return new Promise((resolve) => {
    let p;
    try { p = spawn(SYSTEMD_RUN, ['--user', '--quiet', '--wait', '--collect', '--', '/bin/true'], { stdio: 'ignore' }); }
    catch (e) { systemdRunOk = false; return resolve(false); }
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} systemdRunOk = false; resolve(false); }, 5000);
    p.on('error', () => { clearTimeout(t); systemdRunOk = false; resolve(false); });
    p.on('close', (c) => { clearTimeout(t); systemdRunOk = c === 0; resolve(systemdRunOk); });
  });
}

const comillas = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";
const VARS_SESION = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'];

// Arma el comando para correrlo fuera de la app con systemd-run (con terminal propia)
function argsSystemdRun(cmd, unidad) {
  const env = { TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: 'cat', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', COLUMNS: '200' };
  for (const k of VARS_SESION) if (process.env[k]) env[k] = process.env[k];
  return ['--user', '--pty', '--quiet', '--wait', '--collect', '--same-dir', '--unit=' + unidad,
    ...Object.entries(env).map(([k, v]) => '--setenv=' + k + '=' + v),
    '--', '/bin/bash', '-lc', cmd];
}

function detenerUnidad(unidad) {
  if (!unidad || !SYSTEMD_RUN) return;
  try { spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', unidad], { stdio: 'ignore' }).on('error', () => {}); } catch (e) {}
}

function analizarPregunta(linea) {
  const t = linea.trimEnd();
  if (RX_PIDE_PASS.test(t)) return { tipo: 'password', sudo: RX_PIDE_SUDO.test(t), texto: t };
  if (RX_PIDE_SINO.test(t)) return { tipo: 'texto', sudo: false, texto: t };
  return null;
}

function escribirAlComando(texto) {
  const p = ejecCmds && ejecCmds.proc;
  if (!p || !p.stdin || p.stdin.destroyed || !p.stdin.writable) return false;
  try { p.stdin.write(texto); return true; } catch (e) { return false; }
}

function correrComando(cmd, opciones = {}) {
  return new Promise((resolve) => {
    const esWin = process.platform === 'win32';
    let terminado = false;
    let timerLimite = null;
    let tiempoAgotado = false;
    const fin = (codigo) => {
      if (terminado) return;
      terminado = true;
      if (timerLimite) clearTimeout(timerLimite);
      resolve({ codigo, tiempoAgotado });
    };

    const env = {
      ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb', NO_COLOR: '1',
      PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: 'cat', COLUMNS: '200', SHELL: '/bin/bash'
    };
    let proc;
    try {
      const opts = {
        detached: !esWin,                       // grupo propio para poder detener todo el árbol
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],        // stdin abierto: así se pueden contestar preguntas
        cwd: os.homedir(),
        env
      };
      if (opciones.fueraDeLaApp) {
        // Fuera de la app: systemd-run --pty necesita una terminal, se la da "script"
        const unidad = 'connection-validation-' + process.pid + '-' + Date.now();
        if (ejecCmds) ejecCmds.unidad = unidad;
        const linea = [SYSTEMD_RUN, ...argsSystemdRun(cmd, unidad)].map(comillas).join(' ');
        proc = spawn(SCRIPT_PTY, ['-qefc', linea, '/dev/null'], opts);
      } else {
        proc = SCRIPT_PTY
          ? spawn(SCRIPT_PTY, ['-qefc', cmd, '/dev/null'], opts)
          : spawn(cmd, { ...opts, shell: true });
      }
    } catch (e) {
      emitirLinea('err', 'No se pudo iniciar: ' + e.message);
      return fin(-1);
    }

    if (ejecCmds) { ejecCmds.proc = proc; ejecCmds.ultimaClave = null; ejecCmds.tEnvio = 0; }
    proc.stdin.on('error', () => {});

    let avisoNnp = false;
    const vigilar = (d) => {
      const txt = d.toString();
      // Si justo después de mandar una contraseña recordada sale "Permission denied" / "Sorry, try again", estaba mal
      if (ejecCmds && ejecCmds.ultimaClave && Date.now() - ejecCmds.tEnvio < 15000 && RX_PASS_MALA.test(txt)) {
        const c = ejecCmds.ultimaClave;
        ejecCmds.ultimaClave = null;
        if (guardadas.delete(c)) {
          setTimeout(() => emitirLinea('sys', '✕ La contraseña recordada para «' + etiquetaDe(c) + '» no funcionó; se borró. Escríbela de nuevo.'), 30);
          emitirCmds({ guardadas: guardadas.size });
        }
      }
      if (!avisoNnp && /no new privileges/i.test(txt)) {
        avisoNnp = true;
        setTimeout(() => emitirLinea('sys', '⚠ sudo está bloqueado porque la app se abrió desde un programa que lo prohíbe (por ejemplo la terminal de VS Code). Ábrela desde el menú de aplicaciones (app instalada) y vuelve a intentar.'), 50);
      }
    };
    const alPausar = (linea) => {
      const p = analizarPregunta(linea);
      if (!p) return;
      // Contraseña recordada: se contesta sola
      if (p.tipo === 'password' && ejecCmds) {
        const clave = claveDe(p);
        const pass = guardadas.get(clave);
        // Si vuelve a preguntar enseguida de mandarla, estaba mal
        if (pass !== undefined && ejecCmds.ultimaClave === clave && Date.now() - ejecCmds.tEnvio < 2500) {
          guardadas.delete(clave);
          emitirLinea('sys', '✕ La contraseña recordada para «' + etiquetaDe(clave) + '» no funcionó; se borró. Escríbela de nuevo.');
          emitirCmds({ guardadas: guardadas.size });
        } else if (pass !== undefined && escribirAlComando(pass + '\n')) {
          ejecCmds.ultimaClave = clave;
          ejecCmds.tEnvio = Date.now();
          emitirLinea('sys', '🔑 Contraseña de «' + etiquetaDe(clave) + '» enviada automáticamente');
          return;
        }
      }
      emitirCmds({ pide: { tipo: p.tipo, sudo: p.sudo, texto: p.texto.slice(-200), hora: Date.now() }, progreso: null });
    };

    const alProgreso = (t) => emitirCmds({ progreso: t.trim().slice(-200) });
    const lectorOut = crearLector('out', alPausar, alProgreso);
    const lectorErr = crearLector('err', alPausar, alProgreso);
    proc.stdout.on('data', (d) => { lectorOut.push(d); vigilar(d); });
    proc.stderr.on('data', (d) => { lectorErr.push(d); vigilar(d); });

    if (opciones.limiteMs > 0) {
      timerLimite = setTimeout(() => {
        tiempoAgotado = true;
        const lim = opciones.limiteMs >= 60000 ? Math.round(opciones.limiteMs / 60000) + ' min' : Math.round(opciones.limiteMs / 1000) + ' s';
        emitirLinea('err', '⏱ Tiempo límite agotado (' + lim + '): se detiene este comando');
        if (ejecCmds) detenerUnidad(ejecCmds.unidad);
        matarArbol(proc);
      }, opciones.limiteMs);
    }

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

async function ejecutarComandos(lista, detenerSiFalla, limiteMs) {
  const total = lista.length;
  const resultados = lista.map(() => 'pendiente');
  let logPath = null;

  try {
    logPath = path.join(bitacora.dir('rectificadores'), `actualizacion_${bitacora.sello()}.log`);
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (e) => console.log('[cmds] no se pudo escribir el log:', e.message));   // disco lleno, etc.: no debe tumbar la app
    logStream.write('# Actualización de rectificadores · ' + bitacora.fecha() + ' ' + bitacora.hora() + '\n# Comandos:\n' + lista.map((c, i) => '#   ' + (i + 1) + '. ' + c).join('\n') + '\n\n');
  } catch (e) {
    logStream = null;
  }

  ejecCmds = { abortado: false, proc: null };
  bitacora.registrar('Rectificadores', 'Inició actualización', total + ' comando(s): ' + lista.join(' ; '));
  emitirCmds({
    fase: 'ejecutando', total, completados: 0, actual: 0, pide: null,
    resultados: [...resultados], inicio: Date.now(), fin: null, error: null, logPath,
    terminal: !!SCRIPT_PTY, limiteMs: limiteMs || 0
  });

  const fueraDeLaApp = await probarSystemdRun();
  if (NO_NEW_PRIVS) {
    emitirLinea('sys', fueraDeLaApp
      ? 'ℹ La app se abrió con "no new privileges" (por ejemplo desde VS Code): los comandos se corren fuera de la app con systemd-run para que sudo funcione.'
      : '⚠ La app se abrió con "no new privileges" (por ejemplo desde VS Code): sudo no va a funcionar. Ábrela desde el menú de aplicaciones.');
  }

  let hayFallos = false;
  for (let i = 0; i < total; i++) {
    if (ejecCmds.abortado) break;
    resultados[i] = 'ejecutando';
    emitirCmds({ actual: i, resultados: [...resultados], pide: null, progreso: null });
    emitirLinea('sys', `[${i + 1}/${total}] $ ${lista[i]}`);

    const t0 = Date.now();
    const { codigo, tiempoAgotado } = await correrComando(lista[i], { limiteMs, fueraDeLaApp });
    ejecCmds.unidad = null;
    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    if (estadoCmds.pide) emitirCmds({ pide: null });

    if (ejecCmds.abortado) {
      resultados[i] = 'detenido';
      emitirLinea('sys', `[${i + 1}/${total}] DETENIDO · ${seg} s`);
      break;
    }

    const ok = codigo === 0 && !tiempoAgotado;
    resultados[i] = ok ? 'ok' : 'fallo';
    if (!ok) hayFallos = true;
    emitirLinea('sys', `[${i + 1}/${total}] ${ok ? 'OK' : tiempoAgotado ? 'FALLÓ (tiempo límite agotado)' : 'FALLÓ (código ' + codigo + ')'} · ${seg} s`);
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
    fase, resultados: [...resultados], fin: Date.now(), pide: null,
    error: hayFallos ? 'Uno o más comandos fallaron' : null
  });
  avisarFinActualizacion(fase, resultados);
  bitacora.registrar('Rectificadores', fase === 'listo' ? 'Terminó bien' : fase === 'detenido' ? 'Detenida por el usuario' : 'Terminó con errores',
    resultados.filter((r) => r === 'ok').length + ' de ' + total + ' correctos' + (logPath ? ' · ' + logPath : ''));
}

// Notificación de Ubuntu al terminar (por si no estás viendo la pantalla)
function avisarFinActualizacion(fase, resultados) {
  try {
    if (!Notification.isSupported()) return;
    const ok = resultados.filter((r) => r === 'ok').length;
    const fallos = resultados.filter((r) => r === 'fallo').length;
    const cuerpo = fase === 'listo' ? `Completada: ${ok} de ${resultados.length} comandos correctos.`
      : fase === 'detenido' ? `Detenida por el usuario (${ok} de ${resultados.length} completados).`
      : `Terminó con errores: ${fallos} comando${fallos === 1 ? '' : 's'} falló.`;
    new Notification({ title: 'Actualización de rectificadores', body: cuerpo }).show();
  } catch (e) {}
}

ipcMain.handle('cmds-run', (_e, datos) => {
  if (ejecCmds) return { ok: false, error: 'Ya hay una ejecución en curso.' };
  const lista = (datos && Array.isArray(datos.comandos) ? datos.comandos : [])
    .map((c) => String(c).trim())
    .filter(Boolean);
  if (!lista.length) return { ok: false, error: 'No hay comandos para ejecutar.' };

  const limiteMin = Number(datos && datos.limiteMin);
  const limiteMs = Number.isFinite(limiteMin) && limiteMin > 0 ? Math.min(limiteMin, 24 * 60) * 60000 : 0;
  ejecutarComandos(lista, !datos || datos.detenerSiFalla !== false, limiteMs).catch((err) => {
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
  detenerUnidad(ejecCmds.unidad);
  matarArbol(ejecCmds.proc);
  return { ok: true };
});

ipcMain.handle('cmds-state-get', () => estadoCmds);

// Contestar lo que pide el comando (contraseña, s/n, etc.)
ipcMain.handle('cmds-input', (_e, texto, datos = {}) => {
  if (!ejecCmds || !ejecCmds.proc) return { ok: false, error: 'No hay un comando corriendo.' };
  const t = String(texto == null ? '' : texto);
  if (datos.ctrlC) {
    escribirAlComando('\x03');
    emitirLinea('sys', '^C enviado');
    return { ok: true };
  }
  if (!escribirAlComando(t + '\n')) return { ok: false, error: 'El comando ya no acepta respuestas.' };
  if (datos.secreto) {
    emitirLinea('sys', '🔑 Contraseña enviada');
    if ((datos.recordar || datos.recordarSudo) && estadoCmds.pide && estadoCmds.pide.tipo === 'password') {
      const clave = claveDe(estadoCmds.pide);
      guardadas.set(clave, t);
      ejecCmds.ultimaClave = clave;   // si sale "Permission denied" enseguida, se borra
      ejecCmds.tEnvio = Date.now();
      emitirCmds({ guardadas: guardadas.size });
    }
  } else if (!SCRIPT_PTY) {
    emitirLinea('sys', '> ' + t);   // sin terminal no hay eco: se muestra lo que mandaste
  }
  if (estadoCmds.pide) emitirCmds({ pide: null });
  return { ok: true };
});
// Remplazar Izumi usa la misma contraseña de sudo recordada y la misma ruta para "no new privileges"
remplazoIzumi.configurar({
  obtenerSudo: () => (guardadas.has('sudo') ? guardadas.get('sudo') : null),
  guardarSudo: (p) => { guardadas.set('sudo', p); emitirCmds({ guardadas: guardadas.size }); },
  olvidarSudo: () => { guardadas.delete('sudo'); emitirCmds({ guardadas: guardadas.size }); },
  systemdRun: async () => ((await probarSystemdRun()) ? SYSTEMD_RUN : null)
});

// La configuración del servidor también usa sudo: misma ruta para "no new privileges"
servidor.configurar({
  systemdRun: async () => ((await probarSystemdRun()) ? SYSTEMD_RUN : null),
  varsSesion: VARS_SESION
});

// El chiller usa la misma ruta para "no new privileges" (sudo dentro del script)
chillerMonitor.configurar({
  systemdRun: async () => ((await probarSystemdRun()) ? SYSTEMD_RUN : null),
  varsSesion: VARS_SESION
});

ipcMain.handle('cmds-sudo-olvidar', () => { guardadas.clear(); emitirCmds({ guardadas: 0 }); return true; });
ipcMain.handle('cmds-sudo-hay', () => guardadas.size);

ipcMain.handle('cmds-open-log', () => {
  const dir = bitacora.dir('rectificadores');
  if (estadoCmds.logPath && fs.existsSync(estadoCmds.logPath)) {
    shell.showItemInFolder(estadoCmds.logPath);
  } else {
    shell.openPath(dir);
  }
  return true;
});

console.log('[main] manejadores de comandos registrados (cmds-run, cmds-stop)');

app.on('before-quit', () => {
  if (ejecCmds) { ejecCmds.abortado = true; detenerUnidad(ejecCmds.unidad); matarArbol(ejecCmds.proc); }
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

let ventanaPrincipal = null;

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
  ventanaPrincipal = win;
  // Al cerrar la ventana principal se cierran también las consolas de Izumi
  win.on('closed', () => { ventanaPrincipal = null; consolasIzumi.cerrarTodas(); });
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
    bitacora.registrar('App', 'Actualización descargada', 'v' + info.version);
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

// Manual de usuario: se guarda en PDF (se imprime manual.html en una ventana oculta)
ipcMain.handle('manual-pdf', async (e) => {
  const { dialog } = require('electron');
  const padre = BrowserWindow.fromWebContents(e.sender) || undefined;
  const r = await dialog.showSaveDialog(padre, {
    title: 'Guardar manual de usuario',
    defaultPath: path.join(app.getPath('documents') || os.homedir(), 'Manual-Connection-Validation.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, cancelado: true };
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  try {
    await w.loadFile(path.join(__dirname, 'manual.html'));
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    fs.writeFileSync(r.filePath, pdf);
    bitacora.registrar('App', 'Guardó el manual en PDF', r.filePath);
    shell.showItemInFolder(r.filePath);
    return { ok: true, ruta: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
});

// Bug de Electron en Linux: después de un alert()/confirm() los campos de texto ya no reciben el teclado.
// Quitar y regresar el foco a la ventana lo arregla.
ipcMain.handle('app:reenfocar', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) { w.blur(); w.focus(); w.webContents.focus(); }
  return true;
});
ipcMain.handle('update:buscar', () => buscarActualizaciones());
ipcMain.handle('update:descargar', async () => {
  if (!autoUpdater || descargando) return;   // evita dos descargas a la vez
  descargando = true;
  try { await autoUpdater.downloadUpdate(); } catch (e) { enviarUpdate('error', { mensaje: e.message }); }
  finally { descargando = false; }
});
ipcMain.handle('update:instalar', () => { if (autoUpdater) { bitacora.registrar('App', 'Instalar actualización', 'desde v' + app.getVersion()); autoUpdater.quitAndInstall(); } });

app.whenReady().then(() => {
  if (!app.isPackaged || !esInstanciaPrincipal) return;
  setTimeout(buscarActualizaciones, 5000);                      // al abrir
  setInterval(buscarActualizaciones, 60 * 60 * 1000);           // y cada hora
});

