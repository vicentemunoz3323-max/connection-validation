'use strict';
/* ============================================================
   REVISIÓN DE IZUMIS POR TELNET (proceso principal)
   Al dar "Probar conexión", cada Izumi se revisa por su cuenta y en paralelo
   (los rectificadores siguen con connection_validation.py):

     telnet 10.0.0.253 7000+N   →  se escucha 2 s sin mandar nada
                                →  se mandan dos Enter y se escucha la respuesta

   Resultado:
     - "login:"                       → CONECTADA         (verde)
     - mucha salida sola / mensajes   → BOOTEANDO         (rojo claro)
       de arranque (U-Boot, kernel…)
     - cualquier otra respuesta       → OCUPADA, corriendo pruebas con Ghostfish (naranja)
       (help, Ctrl-X, menús, etc.)
     - no conecta / no contesta nada  → SIN CONEXIÓN      (rojo)
   No se inicia sesión: solo se mira qué contesta y se cierra la conexión.
   ============================================================ */
const { ipcMain, BrowserWindow } = require('electron');
const net = require('net');
const { StringDecoder } = require('string_decoder');

let ZPE = { ZPE_IP: '10.0.0.253', ZPE_PUERTO_BASE: 7000 };
try { ZPE = { ...ZPE, ...(require('./testcase_main.js').CONFIG || {}) }; } catch (e) {}
// Para pruebas en otra PC:  CV_ZPE_IP=127.0.0.1 CV_ZPE_PUERTO_BASE=17000 npx electron .
if (process.env.CV_ZPE_IP) ZPE.ZPE_IP = process.env.CV_ZPE_IP;
if (process.env.CV_ZPE_PUERTO_BASE) ZPE.ZPE_PUERTO_BASE = Number(process.env.CV_ZPE_PUERTO_BASE);

const NUM_IZUMIS = 16;
const T_CONEXION_MS = 5000;     // espera máxima para conectar
const T_ESCUCHA_MS = 2000;      // se escucha sin mandar nada (si está booteando, aquí sale texto solo)
const T_ENTRE_ENTER_MS = 800;   // pausa entre los dos Enter
const T_RESPUESTA_MS = 2500;    // espera de la respuesta después del segundo Enter
const BYTES_BOOT = 300;         // con más de esto llegando solo, se considera que está booteando

const RX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g;
const RX_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const RX_LOGIN = /login:\s*$/i;
const RX_BOOT = /u-boot|starting kernel|booting|uncompressing|loading kernel|dram:|\[\s*\d+\.\d{3,}\]|systemd\[\d+\]|starting .*\.\.\.|initramfs|bootloader|hit any key to stop/i;

let resultados = {};            // n -> { estado, texto, detalle, hora }
let enCurso = false;

let compartido = { consolaAbierta: () => false, escaneando: () => false };
function configurar(opc) { compartido = { ...compartido, ...opc }; }

function enviar(canal, datos) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(canal, datos);
}

const limpiar = (t) => t.replace(RX_ANSI, '').replace(/\r/g, '\n').replace(RX_CONTROL, '');
// La última línea con texto real (se saltan prompts sueltos como ">" o "#")
const primeraLinea = (t) => { const ls = t.split('\n').map((l) => l.trim()).filter(Boolean); return (ls.filter((l) => l.length > 2).pop() || ls.pop() || '').slice(0, 120); };

// Decide el estado con lo que llegó antes y después de los Enter
function clasificar(antes, despues, bytesAntes) {
  const todo = limpiar(antes + despues);
  const final = todo.replace(/\s+$/, '').slice(-200);
  if (RX_LOGIN.test(final)) return { estado: 'ok', texto: 'Conectada', detalle: primeraLinea(final) };
  if (bytesAntes >= BYTES_BOOT || RX_BOOT.test(todo)) return { estado: 'boot', texto: 'Booteando', detalle: primeraLinea(todo) };
  if (limpiar(despues).trim() || limpiar(antes).trim()) return { estado: 'ocupada', texto: 'Ocupada · pruebas Ghostfish', detalle: primeraLinea(todo) };
  return { estado: 'bad', texto: 'Sin respuesta', detalle: 'Conectó al ZPE pero la Izumi no contestó nada' };
}

function revisarUna(n) {
  const puerto = ZPE.ZPE_PUERTO_BASE + n;
  return new Promise((resolve) => {
    let antes = '', despues = '', bytesAntes = 0, fase = 'conectando', terminado = false;
    const dec = new StringDecoder('utf8');
    const timers = [];
    const sock = net.connect({ host: ZPE.ZPE_IP, port: puerto });

    const fin = (r) => {
      if (terminado) return;
      terminado = true;
      timers.forEach(clearTimeout);
      try { sock.destroy(); } catch (e) {}
      resolve({ ...r, puerto, hora: Date.now() });
    };

    timers.push(setTimeout(() => {
      if (fase === 'conectando') fin({ estado: 'bad', texto: 'Sin conexión', detalle: 'El ZPE no respondió en el puerto ' + puerto });
    }, T_CONEXION_MS));

    // Quita la negociación telnet (IAC) y contesta "no" a todo, como telnet sin opciones
    let modo = 'dato', cmd = 0;
    sock.on('data', (buf) => {
      const datos = [];
      for (const b of buf) {
        if (modo === 'dato') { if (b === 255) modo = 'iac'; else datos.push(b); }
        else if (modo === 'iac') {
          if (b === 255) { datos.push(255); modo = 'dato'; }
          else if (b >= 251 && b <= 254) { cmd = b; modo = 'opcion'; }
          else if (b === 250) modo = 'sb';
          else modo = 'dato';
        } else if (modo === 'opcion') {
          try {
            if (cmd === 253) sock.write(Buffer.from([255, 252, b]));       // DO   -> WONT
            else if (cmd === 251) sock.write(Buffer.from([255, 254, b]));  // WILL -> DONT
          } catch (e) {}
          modo = 'dato';
        } else if (modo === 'sb') { if (b === 255) modo = 'sbiac'; }
        else if (modo === 'sbiac') modo = b === 240 ? 'dato' : 'sb';
      }
      if (!datos.length) return;
      const txt = dec.write(Buffer.from(datos));
      if (fase === 'escuchando') { antes += txt; bytesAntes += datos.length; }
      else despues += txt;
      if (antes.length + despues.length > 64 * 1024) { antes = antes.slice(-16384); despues = despues.slice(-16384); }
    });

    sock.on('connect', () => {
      fase = 'escuchando';
      timers.push(setTimeout(() => {
        fase = 'enter';
        try { sock.write('\r\n'); } catch (e) {}
        timers.push(setTimeout(() => {
          try { sock.write('\r\n'); } catch (e) {}
          timers.push(setTimeout(() => fin(clasificar(antes, despues, bytesAntes)), T_RESPUESTA_MS));
        }, T_ENTRE_ENTER_MS));
      }, T_ESCUCHA_MS));
    });

    sock.on('error', (e) => {
      const motivos = {
        ECONNREFUSED: 'El ZPE rechazó la conexión (¿otra sesión usa el puerto ' + puerto + '?)',
        EHOSTUNREACH: 'No se llega a ' + ZPE.ZPE_IP, ENETUNREACH: 'No se llega a ' + ZPE.ZPE_IP,
        ECONNRESET: 'El ZPE cerró la conexión'
      };
      if (fase === 'conectando') fin({ estado: 'bad', texto: 'Sin conexión', detalle: motivos[e.code] || e.message });
      else fin(clasificar(antes, despues, bytesAntes));
    });
    sock.on('close', () => {
      if (fase === 'conectando') fin({ estado: 'bad', texto: 'Sin conexión', detalle: 'El ZPE cerró la conexión' });
      else fin(clasificar(antes, despues, bytesAntes));
    });
  });
}

async function revisarTodas(log) {
  if (enCurso) return { ok: false, error: 'Ya se están revisando las Izumis.' };
  enCurso = true;
  resultados = {};
  enviar('izumis-reset', {});
  const escaneando = compartido.escaneando();
  try {
    await Promise.all(Array.from({ length: NUM_IZUMIS }, (_, k) => k + 1).map(async (n) => {
      let r;
      if (compartido.consolaAbierta(n)) {
        // Su consola está abierta en la app: no se le manda nada para no meterse en tu sesión
        r = { estado: 'consola', texto: 'Consola abierta', detalle: 'No se revisó: tienes su consola abierta en la app', hora: Date.now() };
      } else if (escaneando) {
        r = { estado: 'consola', texto: 'Sin revisar', detalle: 'No se revisó: el escaneo del Test case está usando el ZPE', hora: Date.now() };
      } else {
        enviar('izumi-estado', { n, estado: 'revisando', texto: 'Revisando…' });
        r = await revisarUna(n);
      }
      resultados[n] = r;
      enviar('izumi-estado', { n, ...r });
      if (log) log('Izumi ' + n + ': ' + r.texto + (r.detalle ? ' · ' + r.detalle : '') + '\n');
    }));
  } finally {
    enCurso = false;
  }
  enviar('izumis-listo', resultados);
  return { ok: true, resultados };
}

ipcMain.handle('izumis-get', () => resultados);

module.exports = { configurar, revisarTodas, clasificar, ocupado: () => enCurso };
console.log('[izumi-check] revisión de Izumis por telnet cargada');
