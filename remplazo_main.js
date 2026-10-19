'use strict';
/* ============================================================
   REMPLAZAR IZUMI (proceso principal)
   Lee /etc/dhcp/dhcpd.conf (y dhcpd6.conf) y encuentra la MAC actual de cada Izumi.
   Una Izumi N se reconoce por:
     1) el nombre del host (izumi3, IZUMI_03, izu-3…), o
     2) su IP fija 10.0.0.N
   Se carga desde main.js con:  require('./remplazo_main.js');
   ============================================================ */
const { ipcMain } = require('electron');
const fs = require('fs');

const RUTAS = {
  dhcpd: process.env.CV_DHCPD_PATH || '/etc/dhcp/dhcpd.conf',
  dhcpd6: process.env.CV_DHCPD6_PATH || '/etc/dhcp/dhcpd6.conf'
};
const RED_IZUMI = '10.0.0.';     // la Izumi N tiene la IP 10.0.0.N
const NUM_IZUMIS = 16;

// Quita comentarios (# hasta fin de línea) sin romper textos entre comillas
function sinComentarios(texto) {
  return texto.split('\n').map((l) => {
    let dentro = false;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"') dentro = !dentro;
      else if (l[i] === '#' && !dentro) return l.slice(0, i);
    }
    return l;
  }).join('\n');
}

// Acepta 00:1a:2b:3c:4d:5e, 00-1A-2B-3C-4D-5E, 001a.2b3c.4d5e, 001a2b3c4d5e y la forma corta 0:1a:2b:3c:4d:5
const normalizarMac = (m) => {
  const t = String(m || '').trim();
  const partes = t.split(/[:\-]/);
  if (partes.length === 6 && partes.every((p) => /^[0-9a-f]{1,2}$/i.test(p))) return partes.map((p) => p.padStart(2, '0').toLowerCase()).join(':');
  const h = t.replace(/[.\s]/g, '');
  return /^[0-9a-f]{12}$/i.test(h) ? h.toLowerCase().match(/../g).join(':') : null;
};

// Lista los bloques "host nombre { … }" con su MAC, IP y línea donde empiezan
function leerHosts(texto) {
  const limpio = sinComentarios(texto);
  const hosts = [];
  const rx = /host\s+("?)([^\s{"]+)\1\s*\{([^}]*)\}/gi;
  let m;
  while ((m = rx.exec(limpio))) {
    const cuerpo = m[3];
    const mac = cuerpo.match(/hardware\s+ethernet\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\s*;/i);
    const ip4 = cuerpo.match(/fixed-address\s+([^;]+);/i);
    const ip6 = cuerpo.match(/fixed-address6\s+([^;]+);/i);
    const cid = cuerpo.match(/host-identifier\s+option\s+dhcp6\.client-id\s+([0-9a-f:]+)\s*;/i);
    hosts.push({
      nombre: m[2],
      mac: mac ? normalizarMac(mac[1]) : null,
      ip: ip4 ? ip4[1].trim() : (ip6 ? ip6[1].trim() : null),
      clientId: cid ? cid[1].toLowerCase() : null,
      linea: limpio.slice(0, m.index).split('\n').length
    });
  }
  return hosts;
}

function esIzumi(nombre, n) {
  return new RegExp('(izumi|izu)[^0-9a-z]*0*' + n + '(?![0-9])', 'i').test(nombre);
}

function buscarIzumi(hosts, n) {
  // Primero por nombre, luego por IP 10.0.0.N
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

ipcMain.handle('rz-leer', async () => {
  const a4 = await leerArchivo(RUTAS.dhcpd);
  const a6 = await leerArchivo(RUTAS.dhcpd6);
  const hosts4 = a4.ok ? leerHosts(a4.texto) : [];
  const hosts6 = a6.ok ? leerHosts(a6.texto) : [];
  const izumis = {};
  for (let n = 1; n <= NUM_IZUMIS; n++) {
    const r = buscarIzumi(hosts4, n);
    if (!r) { izumis[n] = null; continue; }
    const mac = r.host.mac;
    // ¿La misma MAC aparece también en dhcpd6.conf? (la tendrás que cambiar ahí también)
    const en6 = mac ? hosts6.filter((h) => h.mac === mac).length : 0;
    izumis[n] = { mac, host: r.host.nombre, ip: r.host.ip, linea: r.host.linea, por: r.por, duplicados: r.duplicados, en6 };
  }
  return {
    ok: a4.ok,
    archivos: {
      dhcpd: { ruta: a4.ruta, existe: a4.existe, error: a4.error || null, hosts: hosts4.length },
      dhcpd6: { ruta: a6.ruta, existe: a6.existe, error: a6.error || null, hosts: hosts6.length }
    },
    izumis,
    // Todas las MAC del archivo, para avisar si la nueva ya la tiene otro equipo
    macs: hosts4.filter((h) => h.mac).map((h) => ({ mac: h.mac, host: h.nombre }))
  };
});

module.exports = { leerHosts, buscarIzumi, normalizarMac };
console.log('[remplazo] módulo Remplazar Izumi cargado');
