'use strict';
/* ============================================================
   CONFIGURACIÓN DEL SERVIDOR (proceso principal)
   Corre server/gf_provisioning.py (versión parchada) en segundo plano:
   - Todo el flujo o un paso suelto (--paso NOMBRE).
   - Las palomitas salen del provisioning_state.json del home (el mismo que usa el script).
   - Contraseñas: llegan de la ventana en cada corrida y se pasan por variables de entorno;
     no se guardan en ningún lado.
   - Valores (IPs, repos, interfaces…): ~/.config/<app>/server/valores.json
   - Script editable: se trabaja con una copia en ~/.config/<app>/server/gf_provisioning.py;
     "Regresar al original" la reemplaza con la que viene en la app.
   - El script avisa con líneas "@@GF {json}" (pasos y preguntas); lo demás va a la consola.
   ============================================================ */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const bitacora = require('./bitacora.js');

const ORIGINAL = path.join(__dirname, 'server', 'gf_provisioning.py');
const dirDatos = () => path.join(app.getPath('userData'), 'server');
const rutaScript = () => path.join(dirDatos(), 'gf_provisioning.py');
const rutaValores = () => path.join(dirDatos(), 'valores.json');

/* Pasos (mismo orden que PASOS en el script). pass = contraseñas que necesita. */
const PASOS = [
  { id: 'set_ID', titulo: 'Número de rack', desc: 'Calcula la IP y el nombre del servidor', pass: [] },
  { id: 'set_network', titulo: 'Red SFC y paquetes base', desc: 'Conexión SFC con IP fija; instala pexpect y minicom (lo que necesita la app), SSH, git, sssd, pip y llaves SSH', pass: ['sudo'] },
  { id: 'gitconfig_cookie', titulo: 'Credenciales de git', desc: 'Copia .gitconfig y .gitcookies del mirror y descarga security-hardened-image', pass: ['mirror'] },
  { id: 'flex_tag', titulo: 'Etiqueta de CrowdStrike', desc: 'Ajusta setup-patch.sh y agrega la llave de apt', pass: ['sudo'] },
  { id: 'run_security_patch', titulo: 'Parche de seguridad', desc: 'Corre setup-patch.sh (puede tardar hasta 1 hora)', pass: ['sudo'] },
  { id: 'validate_and_lego_setup', titulo: 'Validación y lego-infra', desc: 'Valida el parche, descarga lego-infra e instala Ansible', pass: ['sudo'] },
  { id: 'setup_nomachine_yaml', titulo: 'Liga de NoMachine', desc: 'Pone la URL de NoMachine en la receta de Ansible', pass: [] },
  { id: 'run_ansible_playbook', titulo: 'Ansible del servidor', desc: 'Receta lego_abmx_test_server (la más larga)', pass: ['sudo', 'vault'] },
  { id: 'provisional_dhcp', titulo: 'DHCP provisional', desc: 'Escribe dhcpd.conf y dhcpd6.conf y reinicia el DHCP', pass: ['sudo'] },
  { id: 'network_plan', titulo: 'Netplan de las tarjetas de prueba', desc: 'Fija los nombres de ens4f0 y ens4f1 por su MAC', pass: ['sudo'] },
  { id: 'force_test_network_selection', titulo: 'Test Network', desc: 'Deja activa la conexión "Test Network" en ens4f0', pass: ['sudo'] },
  { id: 'reinstall_goss', titulo: 'Goss', desc: 'Reinstala la herramienta de validación', pass: ['sudo'] },
  { id: 'run_final_abmx_config', titulo: 'Configuración final desde el mirror', desc: 'Ansible configure-fish-station corrido desde el mirror', pass: ['sudo', 'vault', 'mirror'] },
  { id: 'create_networkmanager_symlink', titulo: 'Servicio de red', desc: 'Instala paquetes y crea el enlace network-manager.service', pass: ['sudo'] },
  { id: 'juniper_config', titulo: 'Juniper', desc: 'Por cable de consola: versión, contraseña de root, puertos y reinicio', pass: ['sudo', 'juniper'], cable: 'juniper' },
  { id: 'zpe_config', titulo: 'ZPE', desc: 'Por cable de consola: lee la MAC, la pone en el DHCP y configura sus puertos', pass: ['sudo', 'zpe'], cable: 'zpe' },
  { id: 'vrmu_util_config', titulo: 'VRMU util', desc: 'Descarga viperfish-dvc, vrmu_util y firmware', pass: ['sudo'] },
  { id: 'download_python_tools', titulo: 'Herramientas de prueba', desc: 'Copia U22Tocinos del servidor de herramientas como ~/U22-Configurationserver', pass: ['sudo'] },
  { id: 'fix_chrome', titulo: 'Google Chrome', desc: 'Reinstala Chrome limpio (borra su perfil)', pass: ['sudo'] },
  { id: 'end_config_reboot', titulo: 'Terminar y reiniciar', desc: 'Resumen y pregunta si reiniciar el servidor', pass: ['sudo'] }
];
const NOMBRES = new Set(PASOS.map((p) => p.id));

const VALORES_DEFECTO = {
  state_file: 'provisioning_state.json', red_base: '172.24.125.', suma_rack: 99, gateway: '172.24.125.1', dns: '8.8.8.8',
  iface_sfc: 'eno1', hostname_prefijo: 'ghostfish-ist-flg-', mirror_ip: '172.24.125.2', mirror_user: 'testusr',
  repo_security: 'https://mfg-partners.googlesource.com/security-hardened-image', repo_lego: 'https://mfg-partners.googlesource.com/lego-infra',
  crowdstrike_tag: 'Flex_Guadalajara_PROD', nomachine_url: 'https://download.nomachine.com/download/9.8/Linux/nomachine_9.8.2_1_amd64.deb',
  iface_test: 'ens4f0', iface_test2: 'ens4f1', juniper_version: '20.2R2.11', zpe_ip: '10.0.0.253', zpe_user: 'admin',
  tross_ip: '10.0.0.251', vrmu_host: '172.24.125.172', tools_host: '172.24.125.174'
};

let compartido = { systemdRun: async () => null, varsSesion: [] };
function configurar(opc) { compartido = { ...compartido, ...opc }; }

/* ---------- Archivos ---------- */
/* La copia de trabajo se actualiza sola cuando llega una versión nueva de la app,
   pero solo si no la modificaste (se compara con la huella del original del que salió). */
const rutaHuella = () => path.join(dirDatos(), 'original.sha256');
const huella = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
function copiarOriginal() {
  const orig = fs.readFileSync(ORIGINAL);
  fs.writeFileSync(rutaScript(), orig);
  fs.writeFileSync(rutaHuella(), huella(orig));
  return orig;
}
function asegurarScript() {
  fs.mkdirSync(dirDatos(), { recursive: true });
  if (!fs.existsSync(rutaScript())) { copiarOriginal(); return rutaScript(); }
  try {
    const orig = fs.readFileSync(ORIGINAL);
    const actual = fs.readFileSync(rutaScript());
    const deDonde = fs.existsSync(rutaHuella()) ? fs.readFileSync(rutaHuella(), 'utf8').trim() : null;
    if (!orig.equals(actual) && deDonde && huella(actual) === deDonde) {
      copiarOriginal();
      bitacora.registrar('Server', 'Script actualizado con la versión nueva de la app', rutaScript());
    }
  } catch (e) {}
  return rutaScript();
}
function leerValores() {
  try { return { ...VALORES_DEFECTO, ...JSON.parse(fs.readFileSync(rutaValores(), 'utf8')) }; } catch (e) { return { ...VALORES_DEFECTO }; }
}
function rutaEstado() { return path.join(os.homedir(), leerValores().state_file || 'provisioning_state.json'); }
function leerEstado() {
  try {
    const j = JSON.parse(fs.readFileSync(rutaEstado(), 'utf8'));
    const config = { ...(j.config || {}) };
    // Versiones viejas del script guardaban contraseñas aquí: no se mandan a la ventana
    const credViejas = config._credentials ? Object.keys(config._credentials) : [];
    delete config._credentials;
    const archivo = { ...j, config };
    return { flags: j.flags || {}, config, interfaces: j.interfaces || {}, credViejas, archivo, existe: true };
  } catch (e) { return { flags: {}, config: {}, interfaces: {}, credViejas: [], archivo: null, existe: fs.existsSync(rutaEstado()) }; }
}
function editado() {
  try { return fs.existsSync(rutaScript()) && !fs.readFileSync(rutaScript()).equals(fs.readFileSync(ORIGINAL)); } catch (e) { return false; }
}

/* ---------- Envío a la ventana (por lotes, aguanta miles de líneas por segundo) ---------- */
const MAX_HIST = 20000;
const hist = [];
let cola = [];
let timer = null;
function enviar(canal, d) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(canal, d); }
function vaciar() {
  timer = null;
  if (!cola.length) return;
  const lote = cola; cola = [];
  enviar('srv-salida', lote);
}
const RX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
function tipoDe(t) {
  if (/\[✕\]|\bERROR\b|\bError\b|fatal:|FAILED!|Traceback|\bfailed=[1-9]|No such file|Permission denied|refused|Timeout/.test(t)) return 'err';
  if (/\[AVISO\]|\[!\]|WARNING|\[WARN|warning:/i.test(t)) return 'warn';
  if (/\[✓\]|^ok:|\bchanged:|SUCCESS|completad|\bfailed=0\b/.test(t)) return 'ok';
  if (/^---|^\[\*\]|^TASK \[|^PLAY|^={6,}/.test(t)) return 'sys';
  if (/^\[CMD/.test(t)) return 'cmd';
  return 'out';
}
let seq = 0;
function linea(t, tipo) {
  const r = { i: ++seq, t: tipo || tipoDe(t), s: t.length > 3000 ? t.slice(0, 3000) + ' …' : t, h: Date.now() };
  hist.push(r);
  if (hist.length > MAX_HIST + 2000) hist.splice(0, hist.length - MAX_HIST);
  cola.push(r);
  if (run && run.log) { try { run.log.write(t + '\n'); } catch (e) {} }
  if (!timer) timer = setTimeout(vaciar, 50);
}

/* ---------- Corrida ---------- */
let run = null;   // { proc, modo, paso, inicio, actual, estados, pide, log, logPath, abort }
let ultimo = null;

function estadoPublico() {
  const st = leerEstado();
  return {
    pasos: PASOS, flags: st.flags, config: st.config, interfaces: st.interfaces, credViejas: st.credViejas, archivo: st.archivo, existeEstado: st.existe,
    valores: leerValores(), defecto: VALORES_DEFECTO,
    editado: editado(), estadoRuta: rutaEstado(),
    corriendo: run ? { modo: run.modo, paso: run.paso, inicio: run.inicio, actual: run.actual, estados: run.estados, pide: run.pide, log: run.logPath } : null,
    ultimo
  };
}
function emitirEstado() { enviar('srv-estado', estadoPublico()); }

function evento(ev) {
  if (ev.pide) { run.pide = ev; enviar('srv-pide', ev); emitirEstado(); return; }
  if (ev.paso && ev.estado) {
    const previo = run.estados[ev.paso] || {};
    run.estados[ev.paso] = { estado: ev.estado, error: ev.error || null, seg: ev.seg || null, t: ev.estado === 'inicio' ? Date.now() : (previo.t || null) };
    if (ev.estado === 'inicio') run.actual = ev.paso;
    if (ev.estado === 'fallo') run.fallo = { paso: ev.paso, error: ev.error || '' };
    if (ev.estado === 'ok' || ev.estado === 'fallo') bitacora.registrar('Server', ev.estado === 'ok' ? 'Paso terminado' : 'Paso falló', ev.paso + (ev.error ? ' · ' + ev.error : '') + (ev.seg ? ' · ' + ev.seg + ' s' : ''));
    emitirEstado();
  }
}

function crearLector() {
  const dec = new StringDecoder('utf8');
  let resto = '';
  let idle = null;
  const procesar = (crudo) => {
    const t = crudo.replace(RX_ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    const k = t.indexOf('@@GF ');
    if (k >= 0) {
      if (k > 0 && t.slice(0, k).trim()) linea(t.slice(0, k).trimEnd());
      try { evento(JSON.parse(t.slice(k + 5))); } catch (e) { linea(t); }
      return;
    }
    if (t.trim() === '') return;
    linea(t);
  };
  return {
    push(buf) {
      if (idle) { clearTimeout(idle); idle = null; }
      const txt = resto + dec.write(buf);
      const partes = txt.split(/\r\n|\n/);
      resto = partes.pop();
      for (const p of partes) procesar(p.includes('\r') ? p.slice(p.lastIndexOf('\r') + 1) : p);
      // líneas sin salto (preguntas, prompts): se muestran tras un momento
      if (resto) idle = setTimeout(() => { if (resto) { procesar(resto); resto = ''; } }, 500);
    },
    fin() { if (idle) clearTimeout(idle); resto += dec.end(); if (resto) procesar(resto); resto = ''; }
  };
}

const ENV_PASS = { sudo: 'GF_SUDO_PASS', vault: 'GF_VAULT_PASS', mirror: 'GF_MIRROR_PASS', juniper: 'GF_JUNIPER_PASS', zpe: 'GF_ZPE_PASS' };

async function correr(opc = {}) {
  if (run) return { ok: false, error: 'Ya hay una configuración corriendo.' };
  let script;
  try { script = asegurarScript(); } catch (e) { return { ok: false, error: 'No se pudo preparar el script: ' + e.message }; }
  if (!fs.existsSync(ORIGINAL) && !fs.existsSync(script)) return { ok: false, error: 'Falta server/gf_provisioning.py en la app.' };

  const args = ['-u', script];
  let modo = 'todo', paso = null;
  if (opc.tross) { modo = 'tross'; args.push('--tross-mac', String(opc.tross)); }
  else if (opc.paso) {
    if (!NOMBRES.has(opc.paso)) return { ok: false, error: 'Paso desconocido: ' + opc.paso };
    modo = 'paso'; paso = opc.paso; args.push('--paso', opc.paso);
  }

  const env = { ...process.env, GF_APP: '1', GF_CONFIG: rutaValores(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb', NO_COLOR: '1' };
  if (opc.rack) env.GF_RACK = String(opc.rack).trim();
  for (const [k, v] of Object.entries(opc.pass || {})) if (ENV_PASS[k] && v) env[ENV_PASS[k]] = String(v);
  try { if (!fs.existsSync(rutaValores())) fs.writeFileSync(rutaValores(), JSON.stringify(leerValores(), null, 2)); } catch (e) {}

  // log de la corrida en la carpeta central
  const logPath = path.join(bitacora.dir('server'), 'server_' + (paso || modo) + '_' + bitacora.sello() + '.log');
  let log = null;
  try { log = fs.createWriteStream(logPath, { flags: 'a' }); log.on('error', () => {}); } catch (e) {}

  run = { proc: null, modo, paso, inicio: Date.now(), actual: null, estados: {}, pide: null, log, logPath, abort: false, fallo: null };
  hist.length = 0;
  enviar('srv-limpiar', {});
  linea('▶ ' + (modo === 'todo' ? 'Configuración completa del servidor' : modo === 'paso' ? 'Paso: ' + paso : 'MAC del Tross') + ' · ' + new Date().toLocaleString('es'), 'sys');
  bitacora.registrar('Server', modo === 'todo' ? 'Inició configuración completa' : modo === 'paso' ? 'Corrió un paso' : 'MAC del Tross', paso || (opc.tross ? String(opc.tross) : '') + (opc.rack ? ' · rack ' + opc.rack : ''));
  emitirEstado();

  // Si la app se abrió con "no new privileges", sudo no funciona dentro: se corre fuera con systemd-run
  let cmd = 'python3', argv = args;
  const sr = await compartido.systemdRun();
  if (sr) {
    const vars = [];
    for (const [k, v] of Object.entries(env)) if (/^GF_|^PYTHON|^TERM$|^NO_COLOR$/.test(k) || (compartido.varsSesion || []).includes(k)) vars.push('--setenv=' + k + '=' + v);
    run.unidad = 'cv-server-' + Date.now();
    cmd = sr;
    argv = ['--user', '--pipe', '--quiet', '--wait', '--collect', '--unit=' + run.unidad, '--working-directory=' + os.homedir(), ...vars, '--', 'python3', ...args];
    linea('(corre fuera de la app con systemd-run para que sudo funcione)', 'sys');
  }

  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, argv, { cwd: os.homedir(), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { terminar(-1, 'No se pudo iniciar Python: ' + e.message); return resolve({ ok: false, error: e.message }); }
    run.proc = p;
    p.stdin.on('error', () => {});
    const out = crearLector(), err = crearLector();
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    let listo = false;
    p.on('error', (e) => { if (listo) return; listo = true; out.fin(); err.fin(); terminar(-1, e.code === 'ENOENT' ? 'No se encontró python3' : e.message); });
    p.on('close', (c) => { if (listo) return; listo = true; out.fin(); err.fin(); terminar(c === null ? -1 : c); });
    resolve({ ok: true });
  });
}

function terminar(codigo, motivo) {
  if (!run) return;
  const r = run;
  if (motivo) linea(motivo, 'err');
  const seg = Math.round((Date.now() - r.inicio) / 1000);
  const dur = Math.floor(seg / 60) + ':' + String(seg % 60).padStart(2, '0');
  const ok = codigo === 0 && !r.fallo && !r.abort;
  if (r.abort) linea('■ Detenido por el usuario · ' + dur, 'warn');
  else if (ok) linea('✓ Terminó sin errores · ' + dur, 'ok');
  else linea('✕ Terminó con error' + (r.fallo ? ' en el paso ' + r.fallo.paso : ' (código ' + codigo + ')') + ' · ' + dur, 'err');
  vaciar();
  ultimo = { modo: r.modo, paso: r.paso, ok, abort: r.abort, codigo, fallo: r.fallo || (ok || r.abort ? null : { paso: r.actual, error: motivo || 'Código ' + codigo }), fin: Date.now(), estados: r.estados, log: r.logPath, seg };
  bitacora.registrar('Server', r.abort ? 'Detenido' : ok ? 'Terminó bien' : 'Terminó con error', (r.paso || r.modo) + ' · ' + dur + (ultimo.fallo ? ' · ' + ultimo.fallo.paso + ': ' + (ultimo.fallo.error || '') : '') + ' · ' + r.logPath);
  try { if (r.log) r.log.end(); } catch (e) {}
  run = null;
  emitirEstado();
}

function detener() {
  if (!run || !run.proc) return false;
  run.abort = true;
  linea('… Deteniendo', 'warn');
  if (run.unidad) { try { spawn('systemctl', ['--user', 'kill', '--signal=SIGTERM', run.unidad], { stdio: 'ignore' }).on('error', () => {}); } catch (e) {} }
  const p = run.proc;
  try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { try { p.kill('SIGTERM'); } catch (e2) {} }
  setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {} }, 4000);
  return true;
}


/* ---------- Verificar: comprueba que todo quedó instalado como debe ----------
   Solo lee (no cambia nada ni pide contraseña). Cada revisión dice qué paso la deja bien. */
function sh(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', cmd], { timeout, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || '').trim(), err: String(errOut || '').trim() });
    });
  });
}
const qq = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";
const ping = (ip) => sh('ping -c 1 -W 2 ' + qq(ip) + ' >/dev/null 2>&1', 6000).then((r) => r.code === 0);
const activo = (svc) => sh('systemctl is-active ' + qq(svc)).then((r) => r.out === 'active');
const instalado = (pkg) => sh("dpkg-query -W -f='${Status}' " + qq(pkg) + ' 2>/dev/null').then((r) => /install ok installed/.test(r.out));
const existe = (ruta) => fs.existsSync(ruta.replace(/^~/, os.homedir()));
const leer = (ruta) => { try { return fs.readFileSync(ruta, 'utf8'); } catch (e) { return null; } };

async function verificar() {
  const v = leerValores(), st = leerEstado(), c = st.config || {}, home = os.homedir();
  const ip = c.ip_address, sfc = v.iface_sfc || 'eno1', t1 = v.iface_test || 'ens4f0', t2 = v.iface_test2 || 'ens4f1';
  const dhcpd = leer('/etc/dhcp/dhcpd.conf');
  const R = (grupo, nombre, paso, estado, detalle) => ({ grupo, nombre, paso, estado, detalle });
  const ok = (b) => (b ? 'ok' : 'mal');
  const revisiones = [
    // Red
    async () => { const h = (await sh('hostname')).out; return R('Red', 'Nombre del servidor', c.hostname ? 'run_ansible_playbook' : 'set_ID', !c.hostname ? 'aviso' : ok(h === c.hostname), 'Es ' + (h || '—') + (c.hostname ? ' · debe ser ' + c.hostname + ' (lo pone el Ansible)' : ' · falta correr el paso 1')); },
    async () => { const r = await sh('ip -4 -o addr show dev ' + qq(sfc)); const tiene = ip && r.out.includes(ip + '/'); return R('Red', 'IP del servidor en ' + sfc, 'set_network', !ip ? 'aviso' : ok(tiene), tiene ? ip : 'Tiene: ' + ((r.out.match(/inet (\S+)/) || [])[1] || 'sin IP') + (ip ? ' · debe ser ' + ip : '')); },
    async () => { const r = await sh('nmcli -t -f NAME,DEVICE connection show --active'); const a = r.out.split('\n').some((l) => l.startsWith('SFC:')); return R('Red', 'Conexión SFC activa', 'set_network', ok(a), a ? 'SFC activa' : 'No está activa la conexión "SFC"'); },
    async () => { const b = await ping(v.gateway || '172.24.125.1'); return R('Red', 'Gateway', 'set_network', ok(b), (v.gateway || '172.24.125.1') + (b ? ' contesta' : ' no contesta')); },
    async () => { const b = await ping(v.mirror_ip || '172.24.125.2'); return R('Red', 'Mirror', 'gitconfig_cookie', ok(b), (v.mirror_ip || '172.24.125.2') + (b ? ' contesta' : ' no contesta')); },
    async () => { const b = await ping('8.8.8.8'); return R('Red', 'Salida a internet', 'set_network', b ? 'ok' : 'aviso', b ? '8.8.8.8 contesta' : 'No contesta 8.8.8.8 (apt y descargas van a fallar)'); },
    async () => { const b = await activo('ssh'); return R('Red', 'Servicio SSH', 'set_network', ok(b), b ? 'Activo' : 'No está activo (sudo systemctl enable --now ssh)'); },
    // Paquetes base
    async () => { const pk = ['python3-pexpect', 'minicom', 'git', 'openssh-server', 'sssd', 'python3-pip']; const f = []; for (const k of pk) if (!(await instalado(k))) f.push(k); return R('Paquetes', 'Paquetes base', 'set_network', ok(!f.length), f.length ? 'Faltan: ' + f.join(', ') : pk.join(', ')); },
    async () => { const pk = ['libsss-sudo', 'gnome-control-center']; const f = []; for (const k of pk) if (!(await instalado(k))) f.push(k); return R('Paquetes', 'libsss-sudo y gnome-control-center', 'create_networkmanager_symlink', ok(!f.length), f.length ? 'Faltan: ' + f.join(', ') : 'Instalados'); },
    async () => { const b = ['/lib/systemd/system/network-manager.service', '/usr/lib/systemd/system/network-manager.service', '/etc/systemd/system/network-manager.service'].some((r) => existe(r)); return R('Paquetes', 'Enlace network-manager.service', 'create_networkmanager_symlink', ok(b), b ? 'Existe' : 'No existe el enlace'); },
    // Seguridad
    async () => { const b = existe(path.join(home, 'security-hardened-image')); return R('Seguridad', 'Repo security-hardened-image', 'gitconfig_cookie', ok(b), b ? '~/security-hardened-image' : 'No está en tu carpeta personal'); },
    async () => { const b = existe(path.join(home, '.gitcookies')) && existe(path.join(home, '.gitconfig')); return R('Seguridad', 'Credenciales de git', 'gitconfig_cookie', ok(b), b ? '.gitconfig y .gitcookies' : 'Falta .gitconfig o .gitcookies'); },
    async () => { const a = await activo('falcon-sensor'); const i = a || (await instalado('falcon-sensor')); return R('Seguridad', 'Agente CrowdStrike (falcon-sensor)', 'run_security_patch', a ? 'ok' : i ? 'aviso' : 'mal', a ? 'Corriendo' : i ? 'Instalado pero no está corriendo' : 'No está instalado'); },
    // Estación
    async () => { const b = existe(path.join(home, 'lego-infra')); return R('Estación', 'Repo lego-infra', 'validate_and_lego_setup', ok(b), b ? '~/lego-infra' : 'No está en tu carpeta personal'); },
    async () => { const r = await sh('ansible --version 2>/dev/null | head -1'); return R('Estación', 'Ansible', 'validate_and_lego_setup', ok(r.code === 0 && r.out), r.out || 'No está instalado'); },
    async () => { const b = existe('/usr/NX/bin/nxserver') || (await instalado('nomachine')); return R('Estación', 'NoMachine', 'run_ansible_playbook', ok(b), b ? 'Instalado' : 'No está instalado'); },
    async () => { const r = await sh('goss --version 2>/dev/null'); return R('Estación', 'Goss', 'reinstall_goss', ok(r.code === 0 && r.out), r.out || 'No está instalado'); },
    async () => { const r = await sh('google-chrome --version 2>/dev/null'); return R('Estación', 'Google Chrome', 'fix_chrome', ok(r.code === 0 && r.out), r.out || 'No está instalado'); },
    // DHCP y tarjetas
    async () => { const a = await activo('isc-dhcp-server'), b = await activo('isc-dhcp-server6'); return R('DHCP y tarjetas', 'Servicio DHCP (IPv4 / IPv6)', 'provisional_dhcp', a && b ? 'ok' : a ? 'aviso' : 'mal', 'IPv4 ' + (a ? 'activo' : 'apagado') + ' · IPv6 ' + (b ? 'activo' : 'apagado')); },
    async () => { const n = dhcpd ? (dhcpd.match(/host\s+izumi-\d+/g) || []).length : 0; return R('DHCP y tarjetas', 'Izumis en dhcpd.conf', 'provisional_dhcp', dhcpd == null ? 'mal' : n >= 16 ? 'ok' : 'aviso', dhcpd == null ? 'No existe /etc/dhcp/dhcpd.conf' : n + ' de 16 Izumis'); },
    async () => { const f = []; for (const t of [t1, t2]) { const mac = ((await sh('cat /sys/class/net/' + qq(t) + '/address 2>/dev/null')).out || '').toLowerCase(); const esp = String((st.interfaces || {})[t] || '').toLowerCase(); if (!mac) f.push(t + ' no existe'); else if (esp && esp !== mac) f.push(t + ' tiene ' + mac + ' (esperada ' + esp + ')'); } return R('DHCP y tarjetas', 'Tarjetas de prueba ' + t1 + ' / ' + t2, 'network_plan', ok(!f.length), f.length ? f.join(' · ') : 'Existen con su MAC'); },
    async () => { const b = existe('/etc/netplan/01-network-manager-all.yaml'); return R('DHCP y tarjetas', 'Netplan de las tarjetas', 'network_plan', ok(b), b ? '/etc/netplan/01-network-manager-all.yaml' : 'No existe el archivo de netplan'); },
    async () => { const r = await sh('nmcli -t -f NAME,DEVICE connection show --active'); const l = r.out.split('\n').find((x) => x.startsWith('Test Network:')); return R('DHCP y tarjetas', '"Test Network" activa', 'force_test_network_selection', ok(l && l.endsWith(':' + t1)), l ? 'En ' + l.split(':').pop() + (l.endsWith(':' + t1) ? '' : ' · debe estar en ' + t1) : 'No está activa'); },
    // Equipos del rack
    async () => { const zip = v.zpe_ip || '10.0.0.253'; const host = dhcpd && new RegExp('host\\s+zpe\\s*\\{[^}]*' + zip.replace(/\./g, '\\.')).test(dhcpd); const b = await ping(zip); return R('Equipos del rack', 'ZPE', 'zpe_config', host && b ? 'ok' : host || b ? 'aviso' : 'mal', (host ? 'En dhcpd.conf' : 'No está en dhcpd.conf') + ' · ' + zip + (b ? ' contesta' : ' no contesta')); },
    async () => { const b = !!st.flags.juniper_config; return R('Equipos del rack', 'Juniper', 'juniper_config', b ? 'ok' : 'mal', b ? 'Configurado' + (c.juniper_already_configured ? ' (ya estaba)' : '') + ' por ' + (c.juniper_console_device || 'consola') : 'No se ha configurado (se revisa solo por consola)'); },
    async () => { const tip = v.tross_ip || '10.0.0.251'; const host = dhcpd && /host\s+tross\s*\{/.test(dhcpd); const img = existe('/tftpboot/tross'); return R('Equipos del rack', 'Tross', 'vrmu_util_config', host && img ? 'ok' : 'aviso', (host ? 'MAC en dhcpd.conf' : 'Sin MAC en dhcpd.conf (ponla en TROSS)') + ' · imagen ' + (img ? 'en /tftpboot/tross' : 'no está en /tftpboot')); },
    async () => { const r = path.join(home, 'vrmu_util'); let x = false; try { fs.accessSync(r, fs.constants.X_OK); x = true; } catch (e) {} return R('Equipos del rack', 'vrmu_util', 'vrmu_util_config', ok(x), x ? '~/vrmu_util listo' : existe(r) ? 'Existe pero no se puede ejecutar' : 'No está en tu carpeta personal'); },
    async () => { const b2 = await ping('10.254.128.2'), b3 = b2 ? false : await ping('10.254.128.3'); return R('Equipos del rack', 'Controlador de rectificadores', 'vrmu_util_config', b2 || b3 ? 'ok' : 'aviso', b2 ? '10.254.128.2 contesta' : b3 ? '10.254.128.3 contesta (la .2 no)' : 'No contesta ni 10.254.128.2 ni 10.254.128.3'); },
    async () => { const b = existe(path.join(home, 'U22-Configurationserver')); return R('Equipos del rack', 'U22-Configurationserver', 'download_python_tools', ok(b), b ? '~/U22-Configurationserver' : 'No está en tu carpeta personal'); },
    // Cierre
    async () => { const b = existe('/var/run/reboot-required'); return R('Cierre', 'Reinicio pendiente', 'end_config_reboot', b ? 'aviso' : 'ok', b ? 'Hay cambios que se aplican hasta reiniciar' : 'No hace falta reiniciar'); }
  ];
  const resultados = await Promise.all(revisiones.map((f) => f().catch((e) => R('Otros', 'Revisión', null, 'aviso', e.message))));
  const cuenta = { ok: 0, aviso: 0, mal: 0 };
  for (const r of resultados) cuenta[r.estado] = (cuenta[r.estado] || 0) + 1;
  bitacora.registrar('Server', 'Verificó instalación', cuenta.ok + ' bien · ' + cuenta.aviso + ' avisos · ' + cuenta.mal + ' mal');
  bitacora.guardar('server', 'verificacion_' + bitacora.sello() + '.txt', '# Verificación · ' + bitacora.fecha() + ' ' + bitacora.hora() + '\n\n' +
    resultados.map((r) => (r.estado === 'ok' ? '[OK]   ' : r.estado === 'aviso' ? '[AVISO]' : '[MAL]  ') + ' ' + r.grupo + ' · ' + r.nombre + ' — ' + r.detalle).join('\n') + '\n');
  return { ok: true, resultados, cuenta, hora: Date.now() };
}
ipcMain.handle('srv-verificar', () => verificar());

/* ---------- Canales ---------- */
ipcMain.handle('srv-get', () => { try { asegurarScript(); } catch (e) {} return { ...estadoPublico(), hist: hist.slice(-5000) }; });
ipcMain.handle('srv-run', (_e, opc) => correr(opc || {}));
ipcMain.handle('srv-stop', () => detener());
ipcMain.handle('srv-responder', (_e, texto) => {
  if (!run || !run.proc || !run.proc.stdin.writable) return { ok: false, error: 'No hay nada corriendo.' };
  run.proc.stdin.write(String(texto == null ? '' : texto) + '\n');
  const p = run.pide; run.pide = null;
  if (p) bitacora.registrar('Server', 'Respondió', p.pide + (p.pide === 'reinicio' ? ' · ' + texto : ''));
  emitirEstado();
  return { ok: true };
});
ipcMain.handle('srv-desmarcar', (_e, paso) => {
  if (run) return { ok: false, error: 'Espera a que termine la corrida.' };
  if (!NOMBRES.has(paso)) return { ok: false, error: 'Paso desconocido.' };
  try {
    const ruta = rutaEstado();
    const j = fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, 'utf8')) : { flags: {}, config: {} };
    if (j.flags) delete j.flags[paso];
    fs.writeFileSync(ruta, JSON.stringify(j, null, 4));
    bitacora.registrar('Server', 'Desmarcó paso', paso);
    emitirEstado();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srv-valores', (_e, v) => {
  const limpio = {};
  for (const k of Object.keys(VALORES_DEFECTO)) if (v && v[k] !== undefined && String(v[k]).trim() !== '') limpio[k] = k === 'suma_rack' ? Number(v[k]) : String(v[k]).trim();
  try {
    fs.mkdirSync(dirDatos(), { recursive: true });
    fs.writeFileSync(rutaValores(), JSON.stringify({ ...VALORES_DEFECTO, ...limpio }, null, 2));
    bitacora.registrar('Server', 'Guardó valores', Object.keys(limpio).filter((k) => limpio[k] !== VALORES_DEFECTO[k]).join(', ') || 'sin cambios');
    emitirEstado();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srv-script-leer', () => {
  try { return { ok: true, texto: fs.readFileSync(asegurarScript(), 'utf8'), ruta: rutaScript(), editado: editado() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Guarda el script editado; antes revisa que Python lo pueda leer (si tiene error de sintaxis no se guarda)
ipcMain.handle('srv-script-guardar', (_e, texto) => new Promise((resolve) => {
  if (run) return resolve({ ok: false, error: 'Espera a que termine la corrida.' });
  if (typeof texto !== 'string' || texto.length > 3 * 1024 * 1024) return resolve({ ok: false, error: 'Texto no válido.' });
  const tmp = path.join(os.tmpdir(), 'gf_revisar_' + process.pid + '.py');
  try { fs.writeFileSync(tmp, texto); } catch (e) { return resolve({ ok: false, error: e.message }); }
  execFile('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', tmp], { timeout: 15000 }, (err, _o, errOut) => {
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (err) return resolve({ ok: false, error: 'El script tiene un error y no se guardó:\n' + String(errOut || err.message).trim().split('\n').slice(-4).join('\n') });
    try {
      fs.mkdirSync(dirDatos(), { recursive: true });
      fs.writeFileSync(rutaScript(), texto);
      bitacora.registrar('Server', 'Editó el script', rutaScript());
      emitirEstado();
      resolve({ ok: true, editado: editado() });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}));
ipcMain.handle('srv-script-restaurar', () => {
  if (run) return { ok: false, error: 'Espera a que termine la corrida.' };
  try {
    fs.mkdirSync(dirDatos(), { recursive: true });
    copiarOriginal();
    bitacora.registrar('Server', 'Regresó el script al original');
    emitirEstado();
    return { ok: true, texto: fs.readFileSync(rutaScript(), 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Quita las contraseñas que dejaron versiones viejas del script en provisioning_state.json
ipcMain.handle('srv-quitar-cred', () => {
  try {
    const ruta = rutaEstado();
    const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (j.config && j.config._credentials) { delete j.config._credentials; fs.writeFileSync(ruta, JSON.stringify(j, null, 4)); }
    bitacora.registrar('Server', 'Quitó contraseñas guardadas del archivo de banderas', ruta);
    emitirEstado();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srv-abrir-estado', () => {
  const { shell } = require('electron');
  const ruta = rutaEstado();
  if (fs.existsSync(ruta)) shell.showItemInFolder(ruta);
  return { ok: fs.existsSync(ruta), ruta };
});
ipcMain.handle('srv-abrir-log', () => {
  const { shell } = require('electron');
  const p = (run && run.logPath) || (ultimo && ultimo.log);
  if (p && fs.existsSync(p)) shell.showItemInFolder(p); else shell.openPath(bitacora.dir('server'));
  return true;
});

app.on('before-quit', () => { if (run) detener(); });

module.exports = { configurar, ocupado: () => !!run, PASOS };
console.log('[server] módulo de configuración del servidor cargado');
