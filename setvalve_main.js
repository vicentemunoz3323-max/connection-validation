'use strict';
/* ============================================================
   SET VALVE (proceso principal)
   Corre el script set_valve_remote_V2.sh ORIGINAL, sin cambiarle nada:
       bash set_valve_remote_V2.sh <test_host> <slot> <pwm>
   - Se corre una vez por cada slot elegido: con "all", si un slot está caído el set -e
     del script corta ahí y los demás ya no se hacen; así cada slot es independiente.
   - test_host es este mismo servidor; la contraseña de testusr (la misma de sudo con que
     se habilitó el tablero) se le da a ssh con SSH_ASKPASS. No se guarda en ningún archivo.
   - El script copia ~/mfg_ssh_key a la unidad: tiene que estar en la carpeta de testusr.
   ============================================================ */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bitacora = require('./bitacora.js');

// Script original (no se modifica)
const SCRIPT = "#!/bin/bash\n\nset -euo pipefail\n\nusage() {\n    echo \"Usage: $0 <test_host> <slot(1-16)|all> <pwm>\"\n    echo \"Example: $0 172.24.125.166 5 36\"\n    echo \"Example: $0 172.24.125.166 all 36\"\n    exit 1\n}\n\n# Validate arguments\n[ $# -eq 3 ] || usage\n\nTEST_HOST=\"$1\"\nSLOT=\"$2\"\nPWM=\"$3\"\n\n# Validate slot number and generate list\nif [ \"$SLOT\" = \"all\" ]; then\n    # Generate list from 1 to 16\n    SLOTS=\"1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\"\nelif [[ \"$SLOT\" =~ ^[0-9]+$ ]] && [ \"$SLOT\" -ge 1 ] && [ \"$SLOT\" -le 16 ]; then\n    SLOTS=\"$SLOT\"\nelse\n    echo \"Error: slot must be between 1 and 16, or 'all'\"\n    exit 1\nfi\n\necho \"Connecting to test host ${TEST_HOST}...\"\n\n# Pasamos el bloque por SSH. Las variables escapadas (\\$) se evalúan en la máquina remota.\nssh -t \"testusr@${TEST_HOST}\" << EOF\n\nset -e\n\nfor s in ${SLOTS}; do\n    TARGET_IP=\"10.0.0.\\${s}\"\n\n    echo \"==========================================\"\n    echo \"Processing slot \\${s} (IP: \\${TARGET_IP})\"\n    echo \"==========================================\"\n\n    echo \"Copying key to \\${TARGET_IP}...\"\n    scp mfg_ssh_key root@\\${TARGET_IP}:\n\n    echo \"Executing valve command on \\${TARGET_IP}...\"\n    ssh root@\\${TARGET_IP} \"\n        ssh root@fe80::21a:11ff:fe16:fead%gbmcbr -i mfg_ssh_key '/usr/bin/set_valve.sh pwm all ${PWM}'\n    \"\n\n    ssh root@\\${TARGET_IP} \"\n        ssh root@fe80::21a:11ff:fe16:fead%gbmcbr -i mfg_ssh_key '/usr/bin/get_sensors.sh percent'\n    \"\n    echo \"Completed slot \\${s} successfully.\"\n    echo \"\"\ndone\n\necho \"All operations completed successfully.\"\n\nEOF\n\necho \"All SSH sessions closed.\"\n";
const NOMBRE = 'set_valve_remote_V2.sh';
const T_SLOT_MS = 3 * 60 * 1000;

let compartido = { habilitado: () => false, password: () => null, ipServidor: () => null };
function configurar(opc) { compartido = { ...compartido, ...opc }; }

const dirTrabajo = () => path.join(app.getPath('userData'), 'setvalve');
// Copia editable del script (pestaña "Script"). Si no se ha editado, es el original.
const rutaEditada = () => path.join(dirTrabajo(), 'editado_' + NOMBRE);
function textoScript() {
  try { if (fs.existsSync(rutaEditada())) return fs.readFileSync(rutaEditada(), 'utf8'); } catch (e) {}
  return SCRIPT;
}
const editado = () => textoScript() !== SCRIPT;
function prepararArchivos() {
  fs.mkdirSync(dirTrabajo(), { recursive: true });
  const script = path.join(dirTrabajo(), NOMBRE);
  fs.writeFileSync(script, textoScript(), { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  // Contesta a ssh: "yes" a la huella y la contraseña de testusr (llega por variable de entorno)
  const askpass = path.join(dirTrabajo(), 'askpass.sh');
  fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *yes/no*|*fingerprint*) echo yes ;; *) printf \'%s\\n\' "$GF_SV_PASS" ;; esac\n', { mode: 0o700 });
  fs.chmodSync(askpass, 0o700);
  return { script, askpass };
}

let trabajo = null;   // { abort, proc, log }
function enviar(canal, d) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(canal, d); }
function tipoDe(t) {
  if (/Completed slot|completed successfully/i.test(t)) return 'ok';
  if (/error|denied|No route|refused|timed out|No such file|not found|fail/i.test(t)) return 'err';
  if (/^=+$|Processing slot|Connecting to test host/i.test(t)) return 'sys';
  if (/Pseudo-terminal will not be allocated|Warning: Permanently added/i.test(t)) return 'dim';
  return 'out';
}
function linea(t, tipo) {
  const s = String(t).replace(/\r/g, '');
  if (trabajo && trabajo.log) { try { trabajo.log.write(s + '\n'); } catch (e) {} }
  enviar('sv-salida', { t: tipo || tipoDe(s), s });
}
function motivo(texto, codigo) {
  if (/Permission denied|password/i.test(texto)) return 'Contraseña rechazada o la unidad pidió contraseña';
  if (/mfg_ssh_key: No such file/i.test(texto)) return 'Falta ~/mfg_ssh_key en la carpeta de testusr';
  if (/No route to host|timed out|Network is unreachable|Connection refused/i.test(texto)) return 'La unidad no contesta (¿slot vacío o apagado?)';
  if (/No such file|not found/i.test(texto)) return 'No existe el comando en el BMC';
  if (/Tiempo de espera/i.test(texto)) return 'Tardó demasiado';
  return 'Falló (código ' + codigo + ')';
}
// De la salida de get_sensors.sh percent se toma el último número entre 0 y 100
function leerPorcentaje(texto) {
  const nums = String(texto).match(/-?\d+(?:\.\d+)?/g) || [];
  let r = null;
  for (const n of nums) { const v = parseFloat(n); if (v >= 0 && v <= 100) r = Math.round(v * 10) / 10; }
  return r;
}

function correrSlot(archivos, host, n, pwm, pass) {
  return new Promise((resolve) => {
    let todo = '', resto = '', fin = false, p;
    const env = { ...process.env, SSH_ASKPASS: archivos.askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0', GF_SV_PASS: pass || '', LC_ALL: 'C' };
    linea('$ bash ' + NOMBRE + ' ' + host + ' ' + n + ' ' + pwm, 'cmd');
    try { p = spawn('bash', [archivos.script, host, String(n), String(pwm)], { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (e) { return resolve({ codigo: -1, texto: e.message }); }
    trabajo.proc = p;
    const t = setTimeout(() => { todo += '\nTiempo de espera agotado'; try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {} }, T_SLOT_MS);
    const comer = (d) => {
      const s = resto + d.toString('utf8'); const partes = s.split('\n'); resto = partes.pop();
      for (const l of partes) { todo += l + '\n'; if (l.trim()) linea(l); }
    };
    p.stdout.on('data', comer); p.stderr.on('data', comer);
    const listo = (c) => { if (fin) return; fin = true; clearTimeout(t); if (resto.trim()) { todo += resto; linea(resto); } trabajo.proc = null; resolve({ codigo: c, texto: todo }); };
    p.on('error', (e) => { todo += e.message; listo(-1); });
    p.on('close', (c) => listo(c === null ? -1 : c));
  });
}

async function aplicar(opc) {
  if (trabajo) return { ok: false, error: 'Ya se está aplicando. Espera a que termine.' };
  if (!compartido.habilitado()) return { ok: false, error: 'El tablero no está habilitado. Sube el switch y escribe tu contraseña.' };
  const pwm = Number(opc && opc.pwm);
  if (!Number.isInteger(pwm) || pwm < 1 || pwm > 100) return { ok: false, error: 'El valor debe ser un número entero del 1 al 100.' };
  const slots = [...new Set((opc && opc.slots || []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 16).sort((a, b) => a - b);
  if (!slots.length) return { ok: false, error: 'Selecciona al menos un slot.' };
  const host = String((opc && opc.host) || compartido.ipServidor() || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.split('.').some((x) => +x > 255)) return { ok: false, error: 'IP del rack no válida: ' + (host || '(vacía)') };
  const remoto = host !== compartido.ipServidor();
  // En este rack se revisa la llave aquí; en otro rack la tiene que tener su testusr (el script la copia desde allá)
  if (!remoto && !fs.existsSync(path.join(os.homedir(), 'mfg_ssh_key'))) return { ok: false, error: 'Falta ~/mfg_ssh_key en tu carpeta personal: el script la copia a cada unidad.' };
  const passTestusr = (opc && typeof opc.passRemoto === 'string' && opc.passRemoto) ? opc.passRemoto : compartido.password();
  let archivos;
  try { archivos = prepararArchivos(); } catch (e) { return { ok: false, error: 'No se pudo preparar el script: ' + e.message }; }

  let log = null;
  try { log = fs.createWriteStream(path.join(bitacora.dir('setvalve'), 'setvalve_' + bitacora.sello() + '.log'), { flags: 'a' }); log.on('error', () => {}); } catch (e) {}
  trabajo = { abort: false, proc: null, log };
  const resultados = {};
  bitacora.registrar('Set valve', 'Aplicó PWM', pwm + ' · slots ' + (slots.length === 16 ? '1-16' : slots.join(', ')) + ' · rack ' + host + (remoto ? ' (remoto)' : '') + (editado() ? ' · script editado' : ''));
  enviar('sv-estado', { corriendo: true, slots, pwm });
  linea('▶ PWM ' + pwm + ' en ' + (slots.length === 16 ? 'los 16 slots' : 'slot(s) ' + slots.join(', ')) + ' · rack ' + host + (remoto ? ' (otro rack, remoto)' : ' (este rack)') + (editado() ? ' · script EDITADO' : '') + ' · ' + new Date().toLocaleString('es'), 'sys');

  for (const n of slots) {
    if (trabajo.abort) { resultados[n] = { estado: 'detenido', msg: 'Detenido' }; enviar('sv-slot', { n, ...resultados[n] }); continue; }
    enviar('sv-slot', { n, estado: 'corriendo', msg: 'Aplicando…' });
    const r = await correrSlot(archivos, host, n, pwm, passTestusr);
    if (r.codigo === 0 && new RegExp('Completed slot ' + n + ' successfully').test(r.texto)) {
      const despues = r.texto.slice(r.texto.lastIndexOf('Executing valve command'));
      const lectura = leerPorcentaje(despues.replace(/pwm all \d+/g, '').replace(/set pwm \d+/g, '').split('Completed slot')[0]);
      resultados[n] = { estado: 'ok', msg: lectura != null ? 'Leído: ' + lectura + '%' : 'Aplicado', lectura, pwm };
    } else {
      resultados[n] = { estado: trabajo.abort ? 'detenido' : 'fallo', msg: trabajo.abort ? 'Detenido' : motivo(r.texto, r.codigo) };
    }
    enviar('sv-slot', { n, ...resultados[n] });
  }

  const fallas = Object.entries(resultados).filter(([, x]) => x.estado !== 'ok').map(([n]) => +n);
  const abort = trabajo.abort;
  linea(fallas.length ? '✕ Terminó con fallas en slot(s): ' + fallas.join(', ') : '✓ Todos los slots quedaron en PWM ' + pwm, fallas.length ? 'err' : 'ok');
  bitacora.registrar('Set valve', abort ? 'Detenido' : fallas.length ? 'Terminó con fallas' : 'Terminó bien', 'PWM ' + pwm + (fallas.length ? ' · fallaron ' + fallas.join(', ') : ''));
  try { if (log) log.end(); } catch (e) {}
  trabajo = null;
  enviar('sv-estado', { corriendo: false, resultados, pwm, fallas, abort });
  return { ok: true, resultados, fallas };
}

ipcMain.handle('sv-aplicar', (_e, opc) => aplicar(opc));
ipcMain.handle('sv-detener', () => {
  if (!trabajo) return false;
  trabajo.abort = true;
  linea('… Deteniendo', 'warn');
  try { if (trabajo.proc) process.kill(-trabajo.proc.pid, 'SIGTERM'); } catch (e) {}
  return true;
});
ipcMain.handle('sv-obtener', () => ({ corriendo: !!trabajo, host: compartido.ipServidor(), llave: fs.existsSync(path.join(os.homedir(), 'mfg_ssh_key')), editado: editado() }));

/* ---------- Script editable ---------- */
ipcMain.handle('sv-script-leer', () => ({ ok: true, texto: textoScript(), editado: editado() }));
// Antes de guardar se revisa con "bash -n" que no tenga errores de sintaxis
ipcMain.handle('sv-script-guardar', (_e, texto) => new Promise((resolve) => {
  if (trabajo) return resolve({ ok: false, error: 'Espera a que termine de aplicar.' });
  if (typeof texto !== 'string' || !texto.trim() || texto.length > 512 * 1024) return resolve({ ok: false, error: 'Texto no válido.' });
  try { fs.mkdirSync(dirTrabajo(), { recursive: true }); } catch (e) {}
  const tmp = path.join(dirTrabajo(), 'revisar_' + process.pid + '.sh');
  try { fs.writeFileSync(tmp, texto); } catch (e) { return resolve({ ok: false, error: e.message }); }
  require('child_process').execFile('bash', ['-n', tmp], { timeout: 10000 }, (err, _o, errOut) => {
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (err) return resolve({ ok: false, error: 'El script tiene un error y no se guardó:\n' + String(errOut || err.message).replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), NOMBRE).trim().split('\n').slice(-4).join('\n') });
    try {
      if (texto === SCRIPT) { try { fs.unlinkSync(rutaEditada()); } catch (e) {} }
      else fs.writeFileSync(rutaEditada(), texto);
      bitacora.registrar('Set valve', 'Editó el script', texto === SCRIPT ? 'quedó igual al original' : rutaEditada());
      resolve({ ok: true, editado: editado() });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}));
ipcMain.handle('sv-script-restaurar', () => {
  if (trabajo) return { ok: false, error: 'Espera a que termine de aplicar.' };
  try { fs.unlinkSync(rutaEditada()); } catch (e) {}
  bitacora.registrar('Set valve', 'Regresó el script al original');
  return { ok: true, texto: SCRIPT, editado: false };
});
// Ping a la IP del rack antes de lanzar
ipcMain.handle('sv-ping', (_e, ip) => new Promise((resolve) => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''))) return resolve({ ok: false, error: 'IP no válida' });
  require('child_process').execFile('ping', ['-c', '2', '-W', '2', ip], { timeout: 8000 }, (err, out) => {
    const m = String(out || '').match(/time=([\d.]+)/);
    resolve({ ok: !err, ms: m ? +m[1] : null });
  });
}));

module.exports = { configurar, aplicar, leerPorcentaje, SCRIPT, ocupado: () => !!trabajo };
console.log('[setvalve] set valve listo (script original set_valve_remote_V2.sh)');
