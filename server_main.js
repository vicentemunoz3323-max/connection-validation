'use strict';
/* ============================================================
   CONFIGURACIÓN DEL SERVIDOR (proceso principal)
   Corre server/config_engine.py (Config Engine, antes gf_provisioning.py) en segundo plano:
   - Todo el flujo o un paso suelto (--paso NOMBRE).
   - Las palomitas salen de ~/engine_flags.json y ~/engine_flags_tross.json (los mismos que usa el script).
   - Contraseñas: llegan de la ventana en cada corrida y se pasan por variables de entorno;
     no se guardan en ningún lado.
   - Valores (IPs, repos, interfaces…): ~/.config/<app>/server/valores.json
   - Script editable: se trabaja con una copia en ~/.config/<app>/server/config_engine.py;
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

const ORIGINAL = path.join(__dirname, 'server', 'config_engine.py');
const dirDatos = () => path.join(app.getPath('userData'), 'server');
const rutaScript = () => path.join(dirDatos(), 'config_engine.py');
const rutaValores = () => path.join(dirDatos(), 'valores.json');

/* Pasos (mismo orden que PASOS en el script).
   grupo: server | equipos | tross  (tres configuraciones independientes)
   archivo: main = engine_flags.json · tross = engine_flags_tross.json
   pass = contraseñas que se piden al correr (sudo / vault / mirror). */
const GRUPOS = {
  server: { titulo: 'Configurar servidor', sub: 'Red, seguridad, Ansible, DHCP y netplan del servidor ABMX.' },
  equipos: { titulo: 'Configurar Juniper y ZPE', sub: 'Por cable de consola. Cada uno se puede correr solo.' },
  tross: { titulo: 'Configurar Tross', sub: 'VRMU util, MAC, U-Boot, imagen, firmware y prueba de rectificadores.' }
};
const PASOS = [
  { id: 'set_ID', grupo: 'server', titulo: 'Número de rack', desc: 'Calcula la IP y el nombre del servidor', pass: [] },
  { id: 'set_network', grupo: 'server', titulo: 'Red SFC y paquetes base', desc: 'Conexión SFC con IP fija; instala pexpect, minicom, SSH, git, sssd, pip y llaves SSH', pass: ['sudo'] },
  { id: 'gitconfig_cookie', grupo: 'server', titulo: 'Credenciales de git', desc: 'Copia .gitconfig y .gitcookies del mirror y descarga security-hardened-image', pass: ['mirror'] },
  { id: 'flex_tag', grupo: 'server', titulo: 'Etiqueta de CrowdStrike', desc: 'Ajusta setup-patch.sh y agrega la llave de apt', pass: ['sudo'] },
  { id: 'run_security_patch', grupo: 'server', titulo: 'Parche de seguridad', desc: 'Corre setup-patch.sh (puede tardar hasta 1 hora)', pass: ['sudo'] },
  { id: 'validate_and_lego_setup', grupo: 'server', titulo: 'Validación y lego-infra', desc: 'Valida el parche, descarga lego-infra e instala Ansible', pass: ['sudo'] },
  { id: 'setup_nomachine_yaml', grupo: 'server', titulo: 'Liga de NoMachine', desc: 'Pone la URL de NoMachine en la receta de Ansible', pass: [] },
  { id: 'ensure_dhcp', grupo: 'server', titulo: 'Revisar DHCP', desc: 'Revisa que existan dhcpd.conf y dhcpd6.conf y reinicia el DHCP', pass: ['sudo'] },
  { id: 'run_ansible_playbook', grupo: 'server', titulo: 'Ansible del servidor', desc: 'Prueba mirrors de apt, actualiza y corre lego_abmx_test_server (el más largo)', pass: ['sudo', 'vault'] },
  { id: 'provisional_dhcp', grupo: 'server', titulo: 'DHCP del rack', desc: 'Descarga dhcpd.conf y dhcpd6.conf del servidor DHCP y reinicia el servicio', pass: ['sudo'] },
  { id: 'network_plan', grupo: 'server', titulo: 'Netplan de las tarjetas de prueba', desc: 'Fija los nombres de las tarjetas de prueba por su MAC', pass: ['sudo'] },
  { id: 'force_test_network_selection', grupo: 'server', titulo: 'Test Network', desc: 'Deja activa la conexión "Test Network" (se revisa en cada corrida)', pass: ['sudo'], siempre: true },
  { id: 'reinstall_goss', grupo: 'server', titulo: 'Goss', desc: 'Reinstala la herramienta de validación', pass: ['sudo'] },
  { id: 'run_final_abmx_config', grupo: 'server', titulo: 'Configuración final desde el mirror', desc: 'Ansible configure-fish-station corrido desde el mirror', pass: ['sudo', 'vault', 'mirror'] },
  { id: 'create_networkmanager_symlink', grupo: 'server', titulo: 'Servicio de red', desc: 'Instala paquetes y crea el enlace network-manager.service', pass: ['sudo'] },
  { id: 'download_python_tools', grupo: 'server', titulo: 'U22Tocinos', desc: 'Descarga U22Tocinos del servidor de herramientas al home', pass: ['sudo'] },
  { id: 'fix_chrome', grupo: 'server', titulo: 'Google Chrome', desc: 'Reinstala Chrome limpio (borra su perfil)', pass: ['sudo'] },
  { id: 'end_config_reboot', grupo: 'server', titulo: 'Terminar y reiniciar', desc: 'Resumen y reinicio (si nadie contesta, reinicia solo)', pass: ['sudo'] },

  { id: 'juniper_config', grupo: 'equipos', titulo: 'Juniper', desc: 'Por cable de consola: versión, contraseña de root, puertos, rescate y reinicio', pass: ['sudo'], cable: 'juniper' },
  { id: 'zpe_config', grupo: 'equipos', titulo: 'ZPE', desc: 'Por cable de consola: lee la MAC de ETH1, la pone en el DHCP y configura sus puertos', pass: ['sudo'], cable: 'zpe' },

  { id: 'vrmu_util_config', grupo: 'tross', titulo: 'VRMU util e imagen del Tross', desc: 'Descarga viperfish-dvc, vrmu_util, ledare y firmware; copia la imagen a /tftpboot', pass: ['sudo'] },
  { id: 'tross_capture_mac', grupo: 'tross', titulo: 'MAC del Tross', desc: 'La pone en dhcpd.conf (IP fija del Tross) y reinicia el DHCP', pass: ['sudo'] },
  { id: 'tross_dhcp_applied', grupo: 'tross', archivo: 'tross', titulo: 'MAC en el DHCP', desc: 'Etapa 1/13 · confirma la MAC en dhcpd.conf y reinicia el DHCP', pass: ['sudo'] },
  { id: 'tross_uboot_flashed', grupo: 'tross', archivo: 'tross', titulo: 'Flashear U-Boot', desc: 'Etapa 2/13 · cable al puerto 17 del ZPE, reinicio manual y flasheo por consola', pass: [], cable: 'tross' },
  { id: 'tross_linux_booted', grupo: 'tross', archivo: 'tross', titulo: 'Bootear Linux', desc: 'Etapa 3/13 · arranque por red y validación del kernel', pass: [] },
  { id: 'tross_imageset_downloaded', grupo: 'tross', archivo: 'tross', titulo: 'Descargar imageset', desc: 'Etapa 4/13 · imageset.tgz por TFTP y md5', pass: ['sudo'] },
  { id: 'tross_imager_done', grupo: 'tross', archivo: 'tross', titulo: 'Imagear el Tross', desc: 'Etapa 5/13 · tar + imager (unos 20 minutos)', pass: [] },
  { id: 'tross_bootenv_saved', grupo: 'tross', archivo: 'tross', titulo: 'Guardar arranque', desc: 'Etapa 6/13 · bootcase, bootdelay, saveenv y login', pass: [] },
  { id: 'tross_zpe_eth1_reconfigured', grupo: 'tross', archivo: 'tross', titulo: 'ETH1 del ZPE', desc: 'Etapa 7/13 · IP fija en ETH1 del ZPE por SSH', pass: [] },
  { id: 'tross_lease_detected', grupo: 'tross', archivo: 'tross', titulo: 'Lease de red del Tross', desc: 'Etapa 8/13 · busca la IP del Tross en las leases y le hace ping', pass: [] },
  { id: 'tross_vrmu_flash_done', grupo: 'tross', archivo: 'tross', titulo: 'Flash con vrmu_util', desc: 'Etapa 9/13 · dos corridas con espera entre ellas', pass: [] },
  { id: 'tross_vrmu_upgrade_done', grupo: 'tross', archivo: 'tross', titulo: 'Firmware periférico', desc: 'Etapa 10/13 · peripheral upgrade con vrmu_util', pass: [] },
  { id: 'tross_vrmu_fw_version_checked', grupo: 'tross', archivo: 'tross', titulo: 'Versión de firmware', desc: 'Etapa 11/13 · revisa que quedó la versión de Ledare', pass: [] },
  { id: 'tross_voltage_check_done', grupo: 'tross', archivo: 'tross', titulo: 'Voltaje de rectificadores', desc: 'Etapa 12/13 · todos arriba del mínimo (si no, pide power cycle)', pass: [] },
  { id: 'tross_voltage_sequence_tested', grupo: 'tross', archivo: 'tross', titulo: 'Prueba de secuencia', desc: 'Etapa 13/13 · baja el voltaje unos segundos y revisa que respondan', pass: [] }
];
for (const p of PASOS) p.archivo = p.archivo || 'main';
const NOMBRES = new Set(PASOS.map((p) => p.id));
const PASO = Object.fromEntries(PASOS.map((p) => [p.id, p]));

/* Valores que usa el script (los mismos de CFG_DEFECTO en config_engine.py).
   grupo: general / server / equipos / tross · tipo: texto, num, pass (se guarda solo en esta PC). */
const CAMPOS = [
  ['general', 'state_file', 'engine_flags.json', 'Archivo de banderas del servidor y Juniper/ZPE (en el home)'],
  ['general', 'tross_state_file', 'engine_flags_tross.json', 'Archivo de banderas del Tross (en el home)'],
  ['general', 'red_base', '172.24.125.', 'Red base del servidor (sin el último número)'],
  ['general', 'suma_rack', 99, 'Se suma al rack para la IP', 'num'],
  ['general', 'hostname_prefijo', 'ghostfish-ist-flg-', 'Prefijo del nombre del servidor'],
  ['general', 'gateway', '172.24.125.1', 'Gateway'],
  ['general', 'dns', '8.8.8.8', 'DNS'],
  ['general', 'iface_sfc', 'eno1', 'Tarjeta SFC'],
  ['server', 'mirror_ip', '172.24.125.2', 'IP del mirror'],
  ['server', 'mirror_user', 'testusr', 'Usuario del mirror'],
  ['server', 'repo_security', 'https://mfg-partners.googlesource.com/security-hardened-image', 'Repo security-hardened-image'],
  ['server', 'repo_lego', 'https://mfg-partners.googlesource.com/lego-infra', 'Repo lego-infra'],
  ['server', 'crowdstrike_tag', 'Flex_Guadalajara_PROD', 'Etiqueta de CrowdStrike'],
  ['server', 'apt_keyserver', 'hkp://keyserver.ubuntu.com:80', 'Servidor de llaves de apt'],
  ['server', 'apt_key_id', '32EE5355A6BC6E42', 'Llave de apt que se agrega'],
  ['server', 'chrome_key_url', 'https://dl.google.com/linux/linux_signing_key.pub', 'Liga de la llave de Google Chrome'],
  ['server', 'chrome_repo', 'http://dl.google.com/linux/chrome/deb/', 'Repositorio de Google Chrome'],
  ['server', 'nomachine_url', 'https://download.nomachine.com/download/9.8/Linux/nomachine_9.8.2_1_amd64.deb', 'Liga de NoMachine (.deb)'],
  ['server', 'apt_mirrors', 'http://us.archive.ubuntu.com/ubuntu/, http://archive.ubuntu.com/ubuntu/, http://mirrors.edge.kernel.org/ubuntu/, http://mirror.math.princeton.edu/pub/ubuntu/, http://azure.archive.ubuntu.com/ubuntu/', 'Mirrors de Ubuntu a probar (en orden, separados por coma)', 'largo'],
  ['server', 'python_ansible', 'python3.10', 'Python que usa Ansible'],
  ['server', 'setuptools_version', 'setuptools<70.0.0', 'Versión de setuptools'],
  ['server', 'iface_test', 'ens4f0', 'Tarjeta de prueba 1'],
  ['server', 'iface_test2', 'ens4f1', 'Tarjeta de prueba 2'],
  ['server', 'test_network', 'Test Network', 'Nombre de la conexión de prueba'],
  ['server', 'dhcp_host', '172.24.125.136', 'Servidor de donde se bajan dhcpd.conf y dhcpd6.conf'],
  ['server', 'dhcp_user', 'testusr', 'Usuario en ese servidor'],
  ['server', 'goss_url', 'https://goss.rocks/install', 'Instalador de Goss'],
  ['server', 'tools_host', '172.24.125.174', 'Servidor de herramientas'],
  ['server', 'tools_files', 'U22Tocinos', 'Lo que se descarga del servidor de herramientas (separado por coma)'],
  ['server', 'reinicio_min', 5, 'Minutos para reiniciar solo al terminar', 'num'],
  ['equipos', 'consolas', '/dev/ttyUSB0, /dev/ttyUSB1', 'Puertos del cable de consola'],
  ['equipos', 'juniper_baud', 9600, 'Velocidad de consola del Juniper', 'num'],
  ['equipos', 'juniper_version', '20.2R2.11', 'Versión de JUNOS esperada'],
  ['equipos', 'juniper_pass', '', 'Contraseña de root que se le pone al Juniper', 'pass'],
  ['equipos', 'zpe_baud', 115200, 'Velocidad de consola del ZPE', 'num'],
  ['equipos', 'zpe_ip', '10.0.0.253', 'IP del ZPE'],
  ['equipos', 'zpe_user', 'admin', 'Usuario del ZPE'],
  ['equipos', 'zpe_pass', '', 'Contraseña del ZPE', 'pass'],
  ['equipos', 'zpe_script_dir', 'lego-infra/lego_setup/lego_zpe_console_server', 'Carpeta del script de puertos del ZPE (en el home)'],
  ['equipos', 'zpe_script', 'lego_config_zpe_allports.sh', 'Script de puertos del ZPE'],
  ['tross', 'vrmu_host', '172.24.125.172', 'Servidor de VRMU util'],
  ['tross', 'vrmu_items', 'viperfish-dvc, vrmu_util, ledare_1_*, FWContainer_EN_3_AP_00_02_00_09.bin', 'Lo que se descarga de ese servidor (separado por coma)', 'largo'],
  ['tross', 'tross_ip', '10.0.0.251', 'IP fija del Tross'],
  ['tross', 'tross_netmask', '255.255.0.0', 'Máscara del Tross en U-Boot'],
  ['tross', 'tftp_server', '10.0.0.254', 'Servidor TFTP / gateway (Juniper)'],
  ['tross', 'zpe_puerto_tross', 7017, 'Puerto telnet del ZPE para la consola del Tross', 'num'],
  ['tross', 'tross_user', 'root', 'Usuario del Tross'],
  ['tross', 'tross_pass', '', 'Contraseña del Tross', 'pass'],
  ['tross', 'uboot_file', 'tross/uboot_planet-hurricane3.bin', 'Archivo de U-Boot (TFTP)'],
  ['tross', 'uboot_flash', 'MX25L12805', 'Memoria flash esperada'],
  ['tross', 'kernel_file', 'tross/combined.uImage', 'Kernel para arrancar por red (TFTP)'],
  ['tross', 'kernel_version', '4.19.238-planet-hurricane3 #1', 'Versión de kernel esperada'],
  ['tross', 'imageset_file', 'tross/imageset.tgz', 'Imagen (TFTP)'],
  ['tross', 'imageset_md5', '3e52decb2b76aa84f83c5ae97e520c77', 'md5 de imageset.tgz'],
  ['tross', 'imager_md5', '142c29970d23c3e4819f144812a64b79', 'md5 que imprime el imager'],
  ['tross', 'zpe_eth1_bitmask', 8, 'Máscara de ETH1 del ZPE', 'num'],
  ['tross', 'zpe_gateway', '10.0.0.254', 'Gateway de ETH1 del ZPE'],
  ['tross', 'leases_file', '/mnt/region_config/dhcpd/dhcpd.rymden.leases', 'Archivo de leases (en el Tross)'],
  ['tross', 'mac_offset', 2, 'Se suma a la MAC del Tross para buscar su lease', 'num'],
  ['tross', 'ledare_prefix', 'ledare_1_8_5', 'Prefijo de los srec de Ledare'],
  ['tross', 'ledare_version', '1.8.5', 'Versión de Ledare esperada'],
  ['tross', 'fw_container', 'FWContainer_EN_3_AP_00_02_00_09.bin', 'Firmware periférico'],
  ['tross', 'espera_flash_min', 10, 'Minutos de espera entre los 2 flasheos', 'num'],
  ['tross', 'voltaje_min', 50, 'Voltaje DC mínimo de los rectificadores (V)', 'num'],
  ['tross', 'secuencia_voltaje', '45:100:15', 'Secuencia de prueba (voltaje:%:segundos)'],
  ['tross', 'secuencia_min', 40, 'Durante la prueba, voltaje mayor a (V)', 'num'],
  ['tross', 'secuencia_max', 50, 'Durante la prueba, voltaje menor a (V)', 'num']
].map(([grupo, k, def, label, tipo]) => ({ grupo, k, def, label, tipo: tipo || 'texto' }));
const VALORES_DEFECTO = Object.fromEntries(CAMPOS.map((c) => [c.k, c.def]));

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
const NOMBRES_VIEJOS = { state_file: 'provisioning_state.json', tross_state_file: 'tross_config.json' };
function leerValores() {
  let v;
  try { v = { ...VALORES_DEFECTO, ...JSON.parse(fs.readFileSync(rutaValores(), 'utf8')) }; } catch (e) { v = { ...VALORES_DEFECTO }; }
  // valores.json de versiones anteriores traía los nombres viejos de fábrica: se pasan a los de Engine
  for (const [k, viejo] of Object.entries(NOMBRES_VIEJOS)) if (v[k] === viejo) v[k] = VALORES_DEFECTO[k];
  if (v.tools_files === 'dhcpd.py, UUT_test_case.py, share.py, reboot.py, U22Tocinos') v.tools_files = VALORES_DEFECTO.tools_files;   // antes bajaba todo; ahora solo U22Tocinos
  return v;
}
// Racks que ya venían avanzados: las banderas viejas se copian una vez a los nombres nuevos (las viejas no se borran)
function migrarBanderas() {
  for (const [nuevo, viejo] of [[rutaEstado(), path.join(os.homedir(), NOMBRES_VIEJOS.state_file)], [rutaEstadoTross(), path.join(os.homedir(), NOMBRES_VIEJOS.tross_state_file)]]) {
    try {
      if (!fs.existsSync(nuevo) && fs.existsSync(viejo)) {
        fs.copyFileSync(viejo, nuevo); fs.chmodSync(nuevo, 0o600);
        bitacora.registrar('Server', 'Banderas copiadas al nombre nuevo', path.basename(viejo) + ' → ' + path.basename(nuevo));
      }
    } catch (e) {}
  }
}
// A la ventana no se mandan las contraseñas guardadas: solo si hay o no
function valoresPublicos() {
  const v = leerValores();
  for (const c of CAMPOS) if (c.tipo === 'pass') v[c.k] = v[c.k] ? '••••••' : '';
  return v;
}
function rutaEstado() { return path.join(os.homedir(), leerValores().state_file || 'engine_flags.json'); }
function rutaEstadoTross() { return path.join(os.homedir(), leerValores().tross_state_file || 'engine_flags_tross.json'); }
function leerJson(ruta) { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { return null; } }
function leerEstado() {
  migrarBanderas();
  try {
    const j = JSON.parse(fs.readFileSync(rutaEstado(), 'utf8'));
    const config = { ...(j.config || {}) };
    // Versiones viejas del script guardaban contraseñas aquí: no se mandan a la ventana
    const credViejas = config._credentials ? Object.keys(config._credentials) : [];
    delete config._credentials;
    const archivo = { ...j, config };
    const t = leerJson(rutaEstadoTross()) || {};
    return { flags: { ...(j.flags || {}), ...(t.flags || {}) }, config, tross: t.config || {}, interfaces: j.interfaces || {}, credViejas, archivo, existe: true };
  } catch (e) {
    const t = leerJson(rutaEstadoTross()) || {};
    return { flags: { ...(t.flags || {}) }, config: {}, tross: t.config || {}, interfaces: {}, credViejas: [], archivo: null, existe: fs.existsSync(rutaEstado()) };
  }
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
    pasos: PASOS, grupos: GRUPOS, flags: st.flags, config: st.config, tross: st.tross, interfaces: st.interfaces, credViejas: st.credViejas, archivo: st.archivo, existeEstado: st.existe,
    valores: valoresPublicos(), defecto: VALORES_DEFECTO, campos: CAMPOS,
    editado: editado(), estadoRuta: rutaEstado(),
    corriendo: run ? { modo: run.modo, grupo: run.grupo, paso: run.paso, inicio: run.inicio, actual: run.actual, estados: run.estados, pide: run.pide, log: run.logPath } : null,
    ultimo
  };
}
function emitirEstado() { enviar('srv-estado', estadoPublico()); }

function evento(ev) {
  if (ev.pide) { run.pide = { ...ev, desde: Date.now() }; enviar('srv-pide', run.pide); emitirEstado(); return; }
  if (ev.pide_fin) { if (run.pide && run.pide.pide === ev.pide_fin) run.pide = null; emitirEstado(); return; }
  if (ev.paso && ev.estado) {
    const previo = run.estados[ev.paso] || {};
    run.estados[ev.paso] = { estado: ev.estado, error: ev.error || null, seg: ev.seg || null, t: ev.estado === 'inicio' ? Date.now() : (previo.t || null) };
    if (ev.estado === 'inicio') run.actual = ev.paso;
    if (ev.estado === 'fallo') run.fallo = { paso: ev.paso, error: ev.error || '' };
    if (ev.estado === 'pausa') run.pausa = { paso: ev.paso, msg: ev.error || '' };
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

const ENV_PASS = { sudo: 'GF_SUDO_PASS', vault: 'GF_VAULT_PASS', mirror: 'GF_MIRROR_PASS' };

async function correr(opc = {}) {
  if (run) return { ok: false, error: 'Ya hay una configuración corriendo.' };
  let script;
  try { script = asegurarScript(); } catch (e) { return { ok: false, error: 'No se pudo preparar el script: ' + e.message }; }
  if (!fs.existsSync(ORIGINAL) && !fs.existsSync(script)) return { ok: false, error: 'Falta server/config_engine.py en la app.' };

  const args = ['-u', script];
  let modo = 'grupo', paso = null, grupo = opc.grupo;
  if (opc.paso) {
    if (!NOMBRES.has(opc.paso)) return { ok: false, error: 'Paso desconocido: ' + opc.paso };
    modo = 'paso'; paso = opc.paso; grupo = PASO[opc.paso].grupo; args.push('--paso', opc.paso);
  } else if (GRUPOS[grupo]) args.push('--grupo', grupo);
  else return { ok: false, error: 'Grupo desconocido: ' + grupo };

  const env = { ...process.env, GF_APP: '1', GF_CONFIG: rutaValores(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TERM: 'dumb', NO_COLOR: '1' };
  if (opc.rack) env.GF_RACK = String(opc.rack).trim();
  if (opc.trossMac) env.GF_TROSS_MAC = String(opc.trossMac).trim();
  for (const [k, v] of Object.entries(opc.pass || {})) if (ENV_PASS[k] && v) env[ENV_PASS[k]] = String(v);
  try { if (!fs.existsSync(rutaValores())) fs.writeFileSync(rutaValores(), JSON.stringify(leerValores(), null, 2)); } catch (e) {}

  // log de la corrida en la carpeta central
  const logPath = path.join(bitacora.dir('server'), 'engine_' + grupo + '_' + (paso || 'todo') + '_' + bitacora.sello() + '.log');
  let log = null;
  try { log = fs.createWriteStream(logPath, { flags: 'a' }); log.on('error', () => {}); } catch (e) {}

  run = { proc: null, modo, grupo, paso, inicio: Date.now(), actual: null, estados: {}, pide: null, log, logPath, abort: false, fallo: null, pausa: null };
  hist.length = 0;
  enviar('srv-limpiar', {});
  linea('▶ ' + (modo === 'paso' ? 'Paso: ' + PASO[paso].titulo : GRUPOS[grupo].titulo) + ' · ' + new Date().toLocaleString('es'), 'sys');
  bitacora.registrar('Server', modo === 'paso' ? 'Corrió un paso' : 'Inició ' + GRUPOS[grupo].titulo, (paso || grupo) + (opc.rack ? ' · rack ' + opc.rack : ''));
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
  else if (ok && r.pausa) linea('⏸ En pausa · ' + r.pausa.msg + ' · ' + dur, 'warn');
  else if (ok) linea('✓ Terminó sin errores · ' + dur, 'ok');
  else linea('✕ Terminó con error' + (r.fallo ? ' en el paso ' + r.fallo.paso : ' (código ' + codigo + ')') + ' · ' + dur, 'err');
  vaciar();
  ultimo = { modo: r.modo, grupo: r.grupo, paso: r.paso, ok, abort: r.abort, pausa: r.pausa, codigo, fallo: r.fallo || (ok || r.abort ? null : { paso: r.actual, error: motivo || 'Código ' + codigo }), fin: Date.now(), estados: r.estados, log: r.logPath, seg };
  bitacora.registrar('Server', r.abort ? 'Detenido' : r.pausa ? 'En pausa' : ok ? 'Terminó bien' : 'Terminó con error', (r.paso || r.grupo) + ' · ' + dur + (ultimo.fallo ? ' · ' + ultimo.fallo.paso + ': ' + (ultimo.fallo.error || '') : '') + ' · ' + r.logPath);
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
    async () => { const f = String(v.tools_files || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).filter((x) => !existe(path.join(home, x))); return R('Equipos del rack', 'Herramientas de prueba en el home', 'download_python_tools', ok(!f.length), f.length ? 'Faltan: ' + f.join(', ') : 'Están todas'); },
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
    const ruta = PASO[paso].archivo === 'tross' ? rutaEstadoTross() : rutaEstado();
    const j = fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, 'utf8')) : { flags: {}, config: {} };
    if (j.flags) delete j.flags[paso];
    fs.writeFileSync(ruta, JSON.stringify(j, null, 4), { mode: 0o600 });
    bitacora.registrar('Server', 'Desmarcó paso', paso);
    emitirEstado();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srv-valores', (_e, v) => {
  const limpio = {};
  for (const c of CAMPOS) {
    if (!v || v[c.k] === undefined) continue;
    const t = String(v[c.k]);
    if (c.tipo === 'pass') { limpio[c.k] = t === '••••••' ? (leerValores()[c.k] || '') : t; continue; }   // vacía = se pregunta al correr
    if (t.trim() === '') continue;
    if (c.tipo === 'num') { const n = Number(t.trim()); if (!Number.isFinite(n)) return { ok: false, error: '"' + c.label + '" debe ser un número.' }; limpio[c.k] = n; }
    else limpio[c.k] = t.trim();
  }
  try {
    fs.mkdirSync(dirDatos(), { recursive: true });
    // Se guardan encima de lo que ya había: cada grupo solo manda sus valores
    fs.writeFileSync(rutaValores(), JSON.stringify({ ...leerValores(), ...limpio }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(rutaValores(), 0o600); } catch (e) {}
    bitacora.registrar('Server', 'Guardó valores', Object.keys(limpio).filter((k) => limpio[k] !== VALORES_DEFECTO[k]).map((k) => (k.endsWith('_pass') ? k + ' (contraseña)' : k)).join(', ') || 'sin cambios');
    emitirEstado();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Borra engine_flags_tross.json: el Tross se rehace desde la etapa 1 (lo del servidor no se toca)
ipcMain.handle('srv-tross-cero', () => {
  if (run) return { ok: false, error: 'Espera a que termine la corrida.' };
  try {
    for (const r of [rutaEstadoTross(), rutaEstadoTross() + '.bak']) if (fs.existsSync(r)) fs.unlinkSync(r);
    bitacora.registrar('Server', 'Tross desde cero', rutaEstadoTross());
    emitirEstado();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* Pestaña Script con contraseña: se revisa aquí (no en la ventana) y abre por 10 minutos.
   La contraseña NO va en el código. Con la llave USB se compara con su campo "script";
   sin llave se compara con una huella scrypt (con sal), de la que no se puede sacar la contraseña. */
const SCRIPT_SAL = 'e2b3288943e2d05e02f3bad98ff1a552';
const SCRIPT_HUELLA = 'a2a54cdee0d38b94e4fe096b7cb49aeda4434f6acc2b67a0e4fe1232b2a1822b';
let scriptAbierto = 0;
const scriptOk = () => Date.now() < scriptAbierto;
ipcMain.handle('srv-script-clave', (_e, clave) => {
  const crypto = require('crypto');
  const escrita = String(clave || '');
  const deLlave = require('./llave_main.js').clave('script');
  let ok;
  if (deLlave) {
    ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(escrita).digest(), crypto.createHash('sha256').update(deLlave).digest());
  } else {
    ok = crypto.timingSafeEqual(crypto.scryptSync(escrita, Buffer.from(SCRIPT_SAL, 'hex'), 32), Buffer.from(SCRIPT_HUELLA, 'hex'));
  }
  scriptAbierto = ok ? Date.now() + 10 * 60 * 1000 : 0;
  bitacora.registrar('Server', ok ? 'Abrió la pestaña Script' : 'Contraseña incorrecta en Script');
  return { ok };
});
ipcMain.handle('srv-script-cerrar', () => { scriptAbierto = 0; return true; });
ipcMain.handle('srv-script-leer', () => {
  if (!scriptOk()) return { ok: false, bloqueado: true, error: 'Escribe la contraseña para ver el script.' };
  try { return { ok: true, texto: fs.readFileSync(asegurarScript(), 'utf8'), ruta: rutaScript(), editado: editado() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Guarda el script editado; antes revisa que Python lo pueda leer (si tiene error de sintaxis no se guarda)
ipcMain.handle('srv-script-guardar', (_e, texto) => new Promise((resolve) => {
  if (run) return resolve({ ok: false, error: 'Espera a que termine la corrida.' });
  if (!scriptOk()) return resolve({ ok: false, bloqueado: true, error: 'Se cerró por tiempo: vuelve a entrar a la pestaña Script con la contraseña.' });
  if (typeof texto !== 'string' || texto.length > 3 * 1024 * 1024) return resolve({ ok: false, error: 'Texto no válido.' });
  const tmp = path.join(os.tmpdir(), 'engine_revisar_' + process.pid + '.py');
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
  if (!scriptOk()) return { ok: false, bloqueado: true, error: 'Se cerró por tiempo: vuelve a entrar a la pestaña Script con la contraseña.' };
  try {
    fs.mkdirSync(dirDatos(), { recursive: true });
    copiarOriginal();
    bitacora.registrar('Server', 'Regresó el script al original');
    emitirEstado();
    return { ok: true, texto: fs.readFileSync(rutaScript(), 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Quita las contraseñas que dejaron versiones viejas del script en el archivo de banderas
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

module.exports = { configurar, ocupado: () => !!run, PASOS, CAMPOS };
console.log('[server] módulo de configuración del servidor cargado');
