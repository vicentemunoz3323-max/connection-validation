'use strict';
/* ============================================================
   CLONAR (proceso principal)
   Toma el instalable .deb de la carpeta Música de este servidor, lo copia por SSH
   a uno o varios racks y lo instala ahí (sudo apt-get install).

   - No necesita sshpass: la contraseña se le da a ssh/scp con SSH_ASKPASS.
   - La contraseña no se guarda en ningún lado (sale de la llave USB o se escribe).
   - Varios racks al mismo tiempo (PARALELO); cada uno con su estado y su log.
   Se carga desde main.js con:  require('./clonar_main.js');
   ============================================================ */
const { app, ipcMain, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const bitacora = require('./bitacora.js');

const PARALELO = 4;                       // racks al mismo tiempo
const DESTINO_REMOTO = '/tmp/cv_clonar.deb';
const TIEMPO_COPIA_MS = 10 * 60 * 1000;
const TIEMPO_INSTALA_MS = 10 * 60 * 1000;

let trabajo = null;   // { cancelado, procs:Set, filas:{ip:{estado,detalle}} }

/* ---------- Avisos a la ventana ---------- */
function enviar(canal, datos) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.__izumi) w.webContents.send(canal, datos);
}
const log = (ip, texto, tipo) => enviar('clo-log', { ip, texto, tipo: tipo || '' });
function fila(ip, estado, detalle) {
  if (trabajo) trabajo.filas[ip] = { estado, detalle: detalle || '' };
  enviar('clo-fila', { ip, estado, detalle: detalle || '' });
}

/* ---------- Carpeta Música y los .deb ---------- */
function carpetaMusica() {
  const cands = [];
  try { cands.push(app.getPath('music')); } catch (e) {}
  const casa = os.homedir();
  cands.push(path.join(casa, 'Music'), path.join(casa, 'Música'));
  return cands.find((c) => { try { return fs.statSync(c).isDirectory(); } catch (e) { return false; } }) || cands[0];
}

function infoDeb(ruta) {
  return new Promise((res) => {
    execFile('dpkg-deb', ['-f', ruta, 'Package', 'Version'], { timeout: 8000 }, (err, out) => {
      if (err) return res({ paquete: '', version: '' });
      const pk = /Package:\s*(.+)/.exec(out), ve = /Version:\s*(.+)/.exec(out);
      res({ paquete: pk ? pk[1].trim() : '', version: ve ? ve[1].trim() : '' });
    });
  });
}

async function buscarDebs() {
  const dir = carpetaMusica();
  let nombres = [];
  try { nombres = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.deb')); } catch (e) {
    return { dir, debs: [], error: 'No existe la carpeta ' + dir };
  }
  const debs = [];
  for (const n of nombres) {
    const ruta = path.join(dir, n);
    let st;
    try { st = fs.statSync(ruta); } catch (e) { continue; }
    if (!st.isFile()) continue;
    debs.push({ nombre: n, ruta, tam: st.size, fecha: st.mtimeMs, ...(await infoDeb(ruta)) });
  }
  debs.sort((a, b) => b.fecha - a.fecha);   // el más nuevo primero
  return { dir, debs };
}

/* ---------- IPs ---------- */
const RX_IP = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Acepta "172.24.125.101", varias separadas por espacio/coma/renglón y rangos "172.24.125.101-120"
function leerIps(texto) {
  const ips = [], malas = [];
  for (const t of String(texto || '').split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/.exec(t);
    if (m) {
      const a = Number(m[2]), b = Number(m[3]);
      if (a <= b && b <= 255 && b - a <= 254) { for (let i = a; i <= b; i++) ips.push(m[1] + i); continue; }
      malas.push(t); continue;
    }
    if (RX_IP.test(t)) ips.push(t); else malas.push(t);
  }
  return { ips: [...new Set(ips)], malas };
}
function misIps() {
  const s = new Set(['127.0.0.1']);
  for (const l of Object.values(os.networkInterfaces())) for (const i of l || []) if (i.family === 'IPv4') s.add(i.address);
  return s;
}

/* ---------- ssh / scp con la contraseña por SSH_ASKPASS (sin sshpass) ---------- */
let askpass = null;
function rutaAskpass() {
  if (askpass && fs.existsSync(askpass)) return askpass;
  askpass = path.join(app.getPath('userData'), 'clonar-askpass.sh');
  fs.writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$CLO_PASS"\n', { mode: 0o700 });
  fs.chmodSync(askpass, 0o700);
  return askpass;
}
const OPC_SSH = [
  '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
  '-o', 'ConnectTimeout=10', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ServerAliveInterval=15'
];

// Corre ssh/scp. entrada = lo que se le manda por stdin (la contraseña de sudo). Regresa { codigo, salida }.
function correr(ip, prog, args, clave, entrada, limiteMs) {
  return new Promise((res) => {
    const env = { ...process.env, SSH_ASKPASS: rutaAskpass(), SSH_ASKPASS_REQUIRE: 'force', CLO_PASS: clave, DISPLAY: process.env.DISPLAY || ':0' };
    const p = spawn(prog, [...OPC_SSH, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (trabajo) trabajo.procs.add(p);
    let salida = '';
    let resto = '';
    const tomar = (b) => {
      const t = b.toString('utf8');
      salida += t;
      if (t.includes('__VERSION__') && !t.replace(/__VERSION__.*\n?/g, '').trim()) return;   // línea interna, no va al log
      if (salida.length > 200000) salida = salida.slice(-100000);
      const partes = (resto + t).split(/\r?\n|\r/);
      resto = partes.pop();
      for (const l of partes) if (l.trim()) log(ip, l);
    };
    p.stdout.on('data', tomar);
    p.stderr.on('data', tomar);
    p.stdin.on('error', () => {});
    if (entrada) p.stdin.write(entrada);
    p.stdin.end();
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) {} } }, limiteMs);
    p.on('error', (e) => { clearTimeout(timer); if (trabajo) trabajo.procs.delete(p); res({ codigo: -1, salida: e.message }); });
    p.on('close', (codigo) => {
      clearTimeout(timer);
      if (trabajo) trabajo.procs.delete(p);
      if (resto.trim()) log(ip, resto);
      res({ codigo, salida });
    });
  });
}

function explicar(salida, codigo) {
  const s = String(salida || '');
  if (/Permission denied|Authentication failed/i.test(s)) return 'Usuario o contraseña incorrectos';
  if (/incorrect password|Sorry, try again|sudo: \d+ incorrect/i.test(s)) return 'La contraseña de sudo no es correcta';
  if (/No route to host|Network is unreachable/i.test(s)) return 'No se llega a esa IP (red o cable)';
  if (/Connection timed out|Operation timed out/i.test(s)) return 'No contesta (¿apagado o IP equivocada?)';
  if (/Connection refused/i.test(s)) return 'Rechazó la conexión (¿SSH apagado?)';
  if (/Could not get lock|dpkg was interrupted/i.test(s)) return 'apt está ocupado en ese rack (otra instalación); intenta en un rato';
  if (/No space left/i.test(s)) return 'Sin espacio en el disco del rack';
  if (codigo === null) return 'Se canceló o tardó demasiado';
  const ult = s.trim().split('\n').filter((l) => l.trim() && !l.startsWith('__VERSION__')).pop();
  return ult ? ult.slice(0, 200) : 'Falló (código ' + codigo + ')';
}

/* ---------- Clonar a una IP ---------- */
async function clonarUna(ip, deb, usuario, clave) {
  const destino = usuario + '@' + ip;
  if (trabajo.cancelado) { fila(ip, 'cancelado', 'Cancelado'); return false; }

  fila(ip, 'copiando', 'Copiando ' + deb.nombre + '…');
  log(ip, '──── Copiando ' + deb.nombre + ' a ' + destino + ' ────', 'sys');
  const c = await correr(ip, 'scp', ['-q', deb.ruta, destino + ':' + DESTINO_REMOTO], clave, '', TIEMPO_COPIA_MS);
  if (trabajo.cancelado) { fila(ip, 'cancelado', 'Cancelado'); return false; }
  if (c.codigo !== 0) { const m = explicar(c.salida, c.codigo); fila(ip, 'fallo', m); log(ip, '✗ ' + m, 'err'); return false; }

  fila(ip, 'instalando', 'Instalando…');
  log(ip, '──── Instalando en ' + ip + ' ────', 'sys');
  const q = "'" + DESTINO_REMOTO + "'";
  const remoto = "sudo -S -p '' env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades " + q +
    '; r=$?; rm -f ' + q + '; ' +
    (deb.paquete ? "echo \"__VERSION__ $(dpkg-query -W -f='${Version}' '" + deb.paquete.replace(/'/g, '') + "' 2>/dev/null)\"; " : '') +
    'exit $r';
  const i = await correr(ip, 'ssh', [destino, remoto], clave, clave + '\n', TIEMPO_INSTALA_MS);
  if (trabajo.cancelado && i.codigo !== 0) { fila(ip, 'cancelado', 'Cancelado'); return false; }
  if (i.codigo !== 0) { const m = explicar(i.salida, i.codigo); fila(ip, 'fallo', m); log(ip, '✗ ' + m, 'err'); return false; }
  const v = /__VERSION__ (\S+)/.exec(i.salida);
  const msg = 'Instalado' + (v ? ' · versión ' + v[1] : '');
  fila(ip, 'ok', msg);
  log(ip, '✓ ' + msg, 'sys');
  return true;
}

async function clonar(datos) {
  if (trabajo) return { ok: false, error: 'Ya hay una instalación corriendo.' };
  const { ips, malas } = leerIps(datos && datos.ips);
  if (malas.length) return { ok: false, error: 'Estas no son IPs válidas: ' + malas.join(', ') };
  if (!ips.length) return { ok: false, error: 'Escribe al menos una IP.' };
  const usuario = String((datos && datos.usuario) || '').trim();
  const clave = String((datos && datos.clave) || '');
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(usuario)) return { ok: false, error: 'Escribe el usuario del rack.' };
  if (!clave) return { ok: false, error: 'Escribe la contraseña.' };
  const ruta = datos && datos.deb;
  const { debs } = await buscarDebs();
  const deb = debs.find((d) => d.ruta === ruta);
  if (!deb) return { ok: false, error: 'No encuentro ese .deb en la carpeta Música. Dale "Buscar de nuevo".' };

  const propias = misIps();
  trabajo = { cancelado: false, procs: new Set(), filas: {} };
  enviar('clo-inicio', { ips, deb: deb.nombre });
  bitacora.registrar('Instalador', 'Inició', deb.nombre + ' → ' + ips.join(', ') + ' (usuario ' + usuario + ')');
  guardarUsuario(usuario);

  const pendientes = [];
  for (const ip of ips) {
    if (propias.has(ip)) { fila(ip, 'omitido', 'Es esta misma PC: no se instala aquí'); continue; }
    fila(ip, 'espera', 'En espera');
    pendientes.push(ip);
  }
  let ok = 0, mal = 0;
  const trabajador = async () => {
    while (pendientes.length) {
      const ip = pendientes.shift();
      if (await clonarUna(ip, deb, usuario, clave)) ok++; else mal++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALELO, pendientes.length) }, trabajador));
  const cancelado = trabajo.cancelado;
  const filas = trabajo.filas;
  trabajo = null;
  const resumen = { ok, mal, cancelado, filas };
  bitacora.registrar('Instalador', cancelado ? 'Cancelado' : 'Terminó', ok + ' instalados, ' + mal + ' con falla');
  enviar('clo-fin', resumen);
  return { ok: true, ...resumen };
}

function cancelar() {
  if (!trabajo) return false;
  trabajo.cancelado = true;
  for (const p of trabajo.procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) {} } }
  return true;
}

/* ---------- Usuario recordado (la contraseña nunca se guarda) ---------- */
const rutaCfg = () => path.join(app.getPath('userData'), 'clonar.json');
function leerUsuario() {
  try { return JSON.parse(fs.readFileSync(rutaCfg(), 'utf8')).usuario || ''; } catch (e) { return ''; }
}
function guardarUsuario(u) {
  try { fs.writeFileSync(rutaCfg(), JSON.stringify({ usuario: u })); } catch (e) {}
}

/* ---------- Canales ---------- */
ipcMain.handle('clo-buscar', () => buscarDebs());
ipcMain.handle('clo-abrir-carpeta', () => shell.openPath(carpetaMusica()));
ipcMain.handle('clo-usuario', () => {
  let u = leerUsuario();
  if (!u) { try { u = os.userInfo().username; } catch (e) { u = ''; } }
  return u;
});
ipcMain.handle('clo-ips', (_e, texto) => leerIps(texto));
ipcMain.handle('clo-clonar', (_e, datos) => clonar(datos));
ipcMain.handle('clo-cancelar', () => cancelar());
ipcMain.handle('clo-estado', () => (trabajo ? { corriendo: true, filas: trabajo.filas } : { corriendo: false }));

module.exports = { leerIps, ocupado: () => !!trabajo };
console.log('[instalador] módulo Instalador cargado');
