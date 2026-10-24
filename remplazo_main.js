'use strict';
/* ============================================================
   REMPLAZAR IZUMI (proceso principal)
   - Lee /etc/dhcp/dhcpd.conf y encuentra la MAC actual de cada Izumi
     (host izumi-N, o por su IP fija 10.0.0.N).
   - La MAC que va en el DHCP es la de la etiqueta + 3 en el último dígito (regla del equipo, ver sumarMac).
   - Remplaza SOLO la MAC de las líneas "host izumi-N" directamente en el archivo (sed),
     revisa el archivo (dhcpd -t) y reinicia el servicio DHCP.
   - En /etc/dhcp/dhcpd6.conf la Izumi N es "host diorite-N" y su MAC va dentro del
     client-id (00:03:00:01:<MAC>). Ahí va la MAC de la etiqueta SIN sumarle nada.
   - No crea respaldos ni copias. Si la revisión o el reinicio fallan, vuelve a poner
     las MAC anteriores en esas mismas líneas.
   Se carga desde main.js con:  require('./remplazo_main.js');
   ============================================================ */
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RUTAS = {
  dhcpd: process.env.CV_DHCPD_PATH || '/etc/dhcp/dhcpd.conf',
  dhcpd6: process.env.CV_DHCPD6_PATH || '/etc/dhcp/dhcpd6.conf'
};
const SUDO = process.env.CV_SUDO || 'sudo';
const RED_IZUMI = '10.0.0.';     // la Izumi N tiene la IP 10.0.0.N
const NUM_IZUMIS = 16;
const SUMA_ETIQUETA = 3;         // MAC del DHCP = MAC de la etiqueta con +3 en el último dígito

// Lo que main.js comparte: contraseña de sudo recordada y la ruta para saltar "no new privileges"
let compartido = { obtenerSudo: () => null, guardarSudo: () => {}, olvidarSudo: () => {}, systemdRun: async () => null };
function configurar(opc) { compartido = { ...compartido, ...opc }; }

/* ---------- MAC ---------- */
// Acepta 98:98:FB:B9:90:A2, 98-98-fb-…, 9898.fbb9.90a2, 9898FBB990A2 y la forma corta 0:1a:2b:3c:4d:5
function normalizarMac(m) {
  const t = String(m || '').trim();
  const partes = t.split(/[:\-]/);
  if (partes.length === 6 && partes.every((p) => /^[0-9a-f]{1,2}$/i.test(p))) return partes.map((p) => p.padStart(2, '0').toUpperCase()).join(':');
  const h = t.replace(/[.\s]/g, '');
  return /^[0-9a-f]{12}$/i.test(h) ? h.toUpperCase().match(/../g).join(':') : null;
}
// Regla del equipo: se le suma 3 SOLO al último dígito hexadecimal.
//   …90:A2 -> …90:A5      …90:19 -> …90:1C
//   si pasa de F, el resultado (10, 11 o 12) remplaza los DOS últimos dígitos:  …90:FE -> …90:11
function sumarMac(mac, n = 3) {
  const h = mac.replace(/:/g, '');
  const v = parseInt(h.slice(-1), 16) + Number(n);
  const nuevo = v < 16 ? h.slice(0, -1) + v.toString(16) : h.slice(0, -2) + v.toString(16).padStart(2, '0');
  return nuevo.toUpperCase().match(/../g).join(':');
}

/* ---------- Lectura del archivo ---------- */
// Cambia los comentarios (# …) por espacios: así las posiciones siguen igual que en el archivo original
function taparComentarios(texto) {
  let out = '', dentro = false, comentario = false;
  for (const ch of texto) {
    if (ch === '\n') { comentario = false; dentro = false; out += ch; continue; }
    if (comentario) { out += ' '; continue; }
    if (ch === '"') dentro = !dentro;
    if (ch === '#' && !dentro) { comentario = true; out += ' '; continue; }
    out += ch;
  }
  return out;
}

function leerHosts(texto) {
  const limpio = taparComentarios(texto);
  const hosts = [];
  const rx = /host\s+("?)([^\s{"]+)\1\s*\{([^}]*)\}/gi;
  let m;
  while ((m = rx.exec(limpio))) {
    const cuerpo = m[3];
    const mac = /hardware\s+ethernet\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\s*;/i.exec(cuerpo);
    const ip4 = cuerpo.match(/fixed-address\s+([^;]+);/i);
    const ip6 = cuerpo.match(/fixed-address6\s+([^;]+);/i);
    // IPv6: host-identifier option dhcp6.client-id 00:03:00:01:92:1A:2B:3C:4D:5E;  -> MAC = los últimos 6
    const cid = /host-identifier\s+option\s+dhcp6\.client-id\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5,})\s*;/i.exec(cuerpo);
    const cidPartes = cid ? cid[1].split(':') : [];
    hosts.push({
      idTexto: cid ? cid[1] : null,
      idPrefijo: cid ? cidPartes.slice(0, -6).join(':') : null,
      mac6: cid ? normalizarMac(cidPartes.slice(-6).join(':')) : null,
      nombre: m[2],
      mac: mac ? normalizarMac(mac[1]) : null,
      macTexto: mac ? mac[1] : null,
      // posición exacta de la MAC dentro del archivo (para cambiar solo eso)
      macInicio: mac ? m.index + m[0].indexOf(cuerpo) + mac.index + mac[0].indexOf(mac[1]) : -1,
      ip: ip4 ? ip4[1].trim() : (ip6 ? ip6[1].trim() : null),
      linea: limpio.slice(0, m.index).split('\n').length
    });
  }
  return hosts;
}

const esIzumi = (nombre, n) => new RegExp('(izumi|izu)[^0-9a-z]*0*' + n + '(?![0-9])', 'i').test(nombre);
// En dhcpd6.conf la Izumi N se llama diorite-N
const esIzumi6 = (nombre, n) => new RegExp('(diorite|izumi|izu)[^0-9a-z]*0*' + n + '(?![0-9])', 'i').test(nombre);
function buscarIzumi6(hosts6, n) {
  const h = hosts6.filter((x) => x.mac6 && esIzumi6(x.nombre, n));
  return h.length ? { host: h[0], duplicados: h.length } : null;
}

function buscarIzumi(hosts, n) {
  const porNombre = hosts.filter((h) => esIzumi(h.nombre, n));
  if (porNombre.length) return { host: porNombre[0], por: 'nombre', duplicados: porNombre.length };
  const porIp = hosts.filter((h) => h.ip && h.ip.split(/[\s,]+/).includes(RED_IZUMI + n));
  if (porIp.length) return { host: porIp[0], por: 'ip', duplicados: porIp.length };
  return null;
}

async function leerArchivo(ruta) {
  try {
    if (!fs.existsSync(ruta)) return { ok: false, existe: false, ruta, texto: '' };
    return { ok: true, existe: true, ruta, texto: await fs.promises.readFile(ruta, 'utf8') };
  } catch (e) {
    return { ok: false, existe: true, ruta, texto: '', error: e.message };
  }
}

async function leerTodo() {
  const a4 = await leerArchivo(RUTAS.dhcpd);
  const a6 = await leerArchivo(RUTAS.dhcpd6);
  const hosts4 = a4.ok ? leerHosts(a4.texto) : [];
  const hosts6 = a6.ok ? leerHosts(a6.texto) : [];
  const izumis = {};
  for (let n = 1; n <= NUM_IZUMIS; n++) {
    const r6 = buscarIzumi6(hosts6, n);
    const v6 = r6 ? { mac: r6.host.mac6, host: r6.host.nombre, ip: r6.host.ip, linea: r6.host.linea, duplicados: r6.duplicados } : null;
    const r = buscarIzumi(hosts4, n);
    if (!r) { izumis[n] = v6 ? { mac: null, host: null, v6 } : null; continue; }
    izumis[n] = { mac: r.host.mac, host: r.host.nombre, ip: r.host.ip, linea: r.host.linea, por: r.por, duplicados: r.duplicados, v6 };
  }
  return { a4, hosts4, a6, hosts6, izumis };
}

ipcMain.handle('rz-leer', async () => {
  const { a4, a6, hosts4, hosts6, izumis } = await leerTodo();
  return {
    ok: a4.ok,
    suma: Number(SUMA_ETIQUETA),
    archivos: {
      dhcpd: { ruta: a4.ruta, existe: a4.existe, error: a4.error || null, hosts: hosts4.length },
      dhcpd6: { ruta: a6.ruta, existe: a6.existe, error: a6.error || null, hosts: hosts6.length }
    },
    izumis,
    macs: hosts4.filter((h) => h.mac).map((h) => ({ mac: h.mac, host: h.nombre })),
    macs6: hosts6.filter((h) => h.mac6).map((h) => ({ mac: h.mac6, host: h.nombre }))
  };
});

/* ---------- Ejecutar como administrador ---------- */
const comillas = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";

// Corre un script de sh como root. Con contraseña usa "sudo -S" (se la pasa por la entrada estándar);
// sin contraseña prueba "sudo -n" (por si no hace falta o ya está en caché).
async function comoRoot(script, password) {
  const base = password != null
    ? [SUDO, '-S', '-p', '', '--', '/bin/sh', '-c', script]
    : [SUDO, '-n', '--', '/bin/sh', '-c', script];
  const sr = await compartido.systemdRun();   // si la app tiene "no new privileges", se corre fuera con systemd-run
  const cmd = sr ? [sr, '--user', '--pipe', '--wait', '--quiet', '--collect', '--', ...base] : base;
  return new Promise((resolve) => {
    let salida = '', err = '', fin = false;
    let p;
    try { p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } }); }
    catch (e) { return resolve({ codigo: -1, salida: '', err: e.message }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 90000);
    p.stdout.on('data', (d) => { salida += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    if (password != null) p.stdin.write(password + '\n');
    p.stdin.end();
    const listo = (c) => { if (fin) return; fin = true; clearTimeout(t); resolve({ codigo: c, salida, err }); };
    p.on('error', (e) => { err += e.message; listo(-1); });
    p.on('close', (c) => listo(c === null ? -1 : c));
  });
}

const pidePassword = (r) => /password is required|a terminal is required|askpass|no tty present/i.test(r.err);
const passwordMala = (r) => /incorrect password|sorry, try again|authentication failure/i.test(r.err);

/* ---------- Remplazar ---------- */

ipcMain.handle('rz-aplicar', async (_e, datos = {}) => {
  const cambiosPedidos = Array.isArray(datos.cambios) ? datos.cambios : [];
  if (!cambiosPedidos.length) return { ok: false, error: 'No hay cambios.' };

  // 1) Se vuelve a leer el archivo y se arma el texto nuevo cambiando solo las MAC
  const { a4, hosts4, a6, hosts6, izumis } = await leerTodo();
  if (!a4.ok) return { ok: false, error: a4.existe ? 'No se pudo leer ' + a4.ruta + ': ' + a4.error : 'No existe ' + a4.ruta };
  const cambios = [];
  for (const c of cambiosPedidos) {
    const n = Number(c.n);
    const nueva = normalizarMac(c.nueva);
    const info = izumis[n];
    if (!info || !info.mac) return { ok: false, error: 'La Izumi ' + n + ' no tiene host con MAC en ' + a4.ruta };
    if (!nueva) return { ok: false, error: 'MAC no válida para la Izumi ' + n };
    if (c.vieja && normalizarMac(c.vieja) !== info.mac) {
      return { ok: false, error: 'La MAC de la Izumi ' + n + ' cambió en el archivo desde que lo leíste (ahora es ' + info.mac + '). Dale "Volver a leer".' };
    }
    const otro = hosts4.find((h) => h.mac === nueva && h.nombre !== info.host);
    if (otro) return { ok: false, error: 'La MAC ' + nueva + ' ya la tiene «' + otro.nombre + '».' };
    const h = hosts4.find((x) => x.nombre === info.host);
    // IPv6 (diorite-N): la MAC de la etiqueta tal cual
    let v6 = null;
    if (info.v6) {
      const etiqueta = normalizarMac(c.etiqueta);
      if (!etiqueta) return { ok: false, error: 'Falta la MAC de la etiqueta de la Izumi ' + n + ' (para dhcpd6.conf)' };
      if (c.vieja6 && normalizarMac(c.vieja6) !== info.v6.mac) {
        return { ok: false, error: 'La MAC de ' + info.v6.host + ' cambió en dhcpd6.conf desde que lo leíste (ahora es ' + info.v6.mac + '). Dale "Volver a leer".' };
      }
      const otro6 = hosts6.find((x) => x.mac6 === etiqueta && x.nombre !== info.v6.host);
      if (otro6) return { ok: false, error: 'La MAC ' + etiqueta + ' ya la tiene «' + otro6.nombre + '» en dhcpd6.conf.' };
      const h6 = hosts6.find((x) => x.nombre === info.v6.host);
      v6 = { host: h6.nombre, vieja: h6.mac6, nueva: etiqueta, idViejo: h6.idTexto, idNuevo: (h6.idPrefijo ? h6.idPrefijo + ':' : '') + etiqueta };
    }
    cambios.push({ n, host: info.host, vieja: info.mac, nueva, texto: h.macTexto, v6 });
  }
  const repetidas = cambios.map((c) => c.nueva).filter((m, i, a) => a.indexOf(m) !== i);
  if (repetidas.length) return { ok: false, error: 'MAC repetida: ' + repetidas[0] };

  // 2) Comandos sed: cambian la MAC solo en la línea "host <nombre> { … hardware ethernet <MAC>; … }"
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const sedCambio = (host, de, a) => "s/^([[:space:]]*host[[:space:]]+" + escRe(host) +
    "[[:space:]]*\\{[^}]*hardware[[:space:]]+ethernet[[:space:]]+)" + escRe(de) + "([[:space:]]*;)/\\1" + a + "\\2/I";
  const verifica = (host, mac) => "^[[:space:]]*host[[:space:]]+" + escRe(host) +
    "[[:space:]]*\\{[^}]*hardware[[:space:]]+ethernet[[:space:]]+" + escRe(mac) + "[[:space:]]*;";
  // IPv6: el bloque "host diorite-N { … }" ocupa varias líneas: se cambia solo dentro de ese bloque
  const bloque6 = (host) => '/^[[:space:]]*host[[:space:]]+' + escRe(host) + '[[:space:]]*\\{/,/\\}/';
  const sedCambio6 = (host, de, a) => bloque6(host) + ' s/(dhcp6\\.client-id[[:space:]]+)' + escRe(de) + '([[:space:]]*;)/\\1' + a + '\\2/I';
  const F = RUTAS.dhcpd;
  const F6 = RUTAS.dhcpd6;
  const c6 = cambios.filter((c) => c.v6);
  const reiniciar = datos.reiniciar !== false;
  const aplicar = cambios.map((c) => 'sed -i -E ' + comillas(sedCambio(c.host, c.texto, c.nueva)) + ' "$F"')
    .concat(c6.map((c) => 'sed -i -E ' + comillas(sedCambio6(c.v6.host, c.v6.idViejo, c.v6.idNuevo)) + ' "$F6"')).join(' && ');
  const regresar = cambios.map((c) => 'sed -i -E ' + comillas(sedCambio(c.host, c.nueva, c.texto)) + ' "$F"')
    .concat(c6.map((c) => 'sed -i -E ' + comillas(sedCambio6(c.v6.host, c.v6.idNuevo, c.v6.idViejo)) + ' "$F6"')).join('; ');
  const revisar = cambios.map((c) => 'grep -Eiq ' + comillas(verifica(c.host, c.nueva)) + ' "$F"')
    .concat(c6.map((c) => 'sed -n -E ' + comillas(bloque6(c.v6.host) + 'p') + ' "$F6" | grep -Eiq ' + comillas('client-id[[:space:]]+' + escRe(c.v6.idNuevo) + '[[:space:]]*;'))).join(' && ');
  const script = [
    'F=' + comillas(F) + '; F6=' + comillas(F6),
    'regresar() { ' + regresar + '; }',
    '{ ' + aplicar + '; } || { regresar; echo "PASO:escribir:fallo"; exit 11; }',
    '{ ' + revisar + '; } || { regresar; echo "PASO:escribir:no-encontrado"; exit 14; }',
    'echo "PASO:escribir:ok"',
    c6.length ? 'echo "PASO:escribir6:ok"' : 'echo "PASO:escribir6:sin-host"',
    'D=$(command -v dhcpd || ls /usr/sbin/dhcpd 2>/dev/null)',
    'if [ -n "$D" ]; then',
    '  if OUT=$("$D" -t -cf "$F" 2>&1); then echo "PASO:revisar:ok"; else echo "$OUT" | tail -n 15; regresar; echo "PASO:revisar:fallo"; exit 12; fi',
    'else echo "PASO:revisar:omitido"; fi',
    c6.length ? [
      'if [ -n "$D" ]; then',
      '  if OUT=$("$D" -6 -t -cf "$F6" 2>&1); then echo "PASO:revisar6:ok"; else echo "$OUT" | tail -n 15; regresar; echo "PASO:revisar6:fallo"; exit 15; fi',
      'else echo "PASO:revisar6:omitido"; fi'
    ].join('\n') : '',
    reiniciar ? [
      'SVC=""; for s in isc-dhcp-server dhcpd; do if systemctl cat "$s.service" >/dev/null 2>&1; then SVC=$s; break; fi; done',
      'if [ -z "$SVC" ]; then echo "PASO:reiniciar:sin-servicio";',
      'elif systemctl restart "$SVC" 2>&1; then echo "PASO:reiniciar:ok:$SVC";',
      'else journalctl -u "$SVC" -n 12 --no-pager 2>/dev/null; regresar; systemctl restart "$SVC" >/dev/null 2>&1; echo "PASO:reiniciar:fallo:$SVC"; exit 13; fi'
    ].join('\n') : 'echo "PASO:reiniciar:no-pedido"',
    reiniciar && c6.length ? [
      'SVC6=""; for s in isc-dhcp-server6 dhcpd6; do if systemctl cat "$s.service" >/dev/null 2>&1; then SVC6=$s; break; fi; done',
      'if [ -z "$SVC6" ]; then echo "PASO:reiniciar6:sin-servicio";',
      'elif systemctl restart "$SVC6" 2>&1; then echo "PASO:reiniciar6:ok:$SVC6";',
      'else journalctl -u "$SVC6" -n 12 --no-pager 2>/dev/null; regresar; systemctl restart "$SVC6" >/dev/null 2>&1; [ -n "$SVC" ] && systemctl restart "$SVC" >/dev/null 2>&1; echo "PASO:reiniciar6:fallo:$SVC6"; exit 16; fi'
    ].join('\n') : '',
    'exit 0'
  ].join('\n');

  // 3) Contraseña: la que mandaste, la recordada, o ninguna (sudo -n)
  let password = datos.password != null ? String(datos.password) : compartido.obtenerSudo();
  let r = await comoRoot(script, password != null ? password : null);
  if (password == null && pidePassword(r)) return { ok: false, necesitaPassword: true };
  if (password != null && (passwordMala(r) || (r.codigo !== 0 && pidePassword(r)))) {
    if (datos.password == null) compartido.olvidarSudo();   // la recordada ya no sirve
    const msg = r.err.split('\n').map((l) => l.trim()).filter((l) => l && !/^sorry, try again/i.test(l)).pop() || '';
    return { ok: false, necesitaPassword: true, error: passwordMala(r) ? 'Contraseña incorrecta' : 'sudo dijo: ' + msg };
  }
  // sudo falló antes de correr nada (sin pasos): se muestra su mensaje tal cual
  if (r.codigo !== 0 && !/PASO:/.test(r.salida)) {
    const msg = (r.err || r.salida).trim().split('\n').slice(-3).join(' · ');
    return { ok: false, error: 'No se pudo ejecutar como administrador' + (msg ? ': ' + msg : ' (código ' + r.codigo + ')'), detalle: (r.err || '').trim().split('\n').slice(-10) };
  }
  if (password != null && datos.recordar) compartido.guardarSudo(password);

  // 4) Resultado paso a paso
  const pasos = {};
  const detalle = [];
  for (const l of (r.salida + '\n' + r.err).split('\n')) {
    const m = l.match(/^PASO:([a-z0-9]+):([a-z\-]+)(?::(.*))?$/);
    if (m) pasos[m[1]] = { estado: m[2], dato: m[3] || '' };
    else if (l.trim() && !/^\[sudo\]/.test(l)) detalle.push(l);
  }
  if (/no new privileges/i.test(r.err)) {
    return { ok: false, error: 'sudo está bloqueado ("no new privileges"). Abre la app desde el menú de aplicaciones.', pasos, detalle: detalle.slice(-15) };
  }
  const ok = r.codigo === 0 && pasos.escribir && pasos.escribir.estado === 'ok';
  return {
    ok, codigo: r.codigo, pasos,
    cambios: cambios.map(({ n, host, vieja, nueva, v6 }) => ({ n, host, vieja, nueva, v6: v6 ? { host: v6.host, vieja: v6.vieja, nueva: v6.nueva } : null })),
    detalle: detalle.slice(-15),
    error: ok ? null : 'No se aplicaron los cambios (código ' + r.codigo + ').'
  };
});

module.exports = { configurar, leerHosts, buscarIzumi, buscarIzumi6, normalizarMac, sumarMac };
console.log('[remplazo] módulo Remplazar Izumi cargado');
