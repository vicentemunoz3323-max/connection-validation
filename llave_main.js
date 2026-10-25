'use strict';
/* ============================================================
   LLAVE USB (proceso principal)
   Una USB con las contraseñas del servidor (sudo, vault, mirror, Juniper, ZPE).
   Al conectarla, la app llena sola las contraseñas en SERVER y TROSS.

   - El archivo vive SOLO en la USB:  <USB>/ghostfish-llave.json
   - Es texto normal (se puede abrir y editar con cualquier editor):
       { "nombre": "Línea 3", "sudo": "...", "vault": "...", "mirror": "...", "juniper": "...", "zpe": "..." }
     Un campo vacío ("") cuenta como que no está y la app lo pide.
   - Nunca se copia al servidor; se lee cuando se necesita y se descarta.
   ============================================================ */
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bitacora = require('./bitacora.js');

const NOMBRE = 'ghostfish-llave.json';
const NOMBRE_VIEJO = 'ghostfish-llave.gfk';   // versión cifrada anterior: se sigue leyendo
const CAMPOS = ['sudo', 'vault', 'mirror', 'juniper', 'zpe'];
const CLAVE = crypto.createHash('sha256').update('ghostfish·connection-validation·llave-usb·v1').digest();

// Carpetas donde Ubuntu monta las USB (/media/<usuario>/<USB>, /run/media/<usuario>/<USB>)
function usbs() {
  const u = process.env.SUDO_USER || process.env.USER || (() => { try { return os.userInfo().username; } catch (e) { return ''; } })();
  const raices = [...new Set([path.join('/media', u), path.join('/run/media', u), '/media'])];
  if (process.env.CV_USB_DIR) raices.unshift(process.env.CV_USB_DIR);   // para pruebas
  const out = [];
  for (const r of raices) {
    let hijos = [];
    try { hijos = fs.readdirSync(r, { withFileTypes: true }); } catch (e) { continue; }
    for (const h of hijos) {
      if (!h.isDirectory()) continue;
      const ruta = path.join(r, h.name);
      if (ruta === path.join('/media', u)) continue;
      if (out.some((x) => x.ruta === ruta)) continue;
      let escribible = false;
      try { fs.accessSync(ruta, fs.constants.W_OK); escribible = true; } catch (e) {}
      const archivo = [NOMBRE, NOMBRE_VIEJO].map((n) => path.join(ruta, n)).find((f) => fs.existsSync(f)) || null;
      out.push({ ruta, nombre: h.name, escribible, tieneLlave: !!archivo, archivo });
    }
  }
  return out;
}

// Lee la llave: texto normal, o la versión cifrada anterior
function interpretar(texto) {
  const j = JSON.parse(texto.replace(/^\uFEFF/, ''));
  if (j.gfk !== 1) return { nombre: j.nombre, creada: j.creada, pass: j.pass && typeof j.pass === 'object' ? j.pass : j };
  const d = crypto.createDecipheriv('aes-256-gcm', CLAVE, Buffer.from(j.iv, 'base64'));
  d.setAuthTag(Buffer.from(j.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.datos, 'base64')), d.final()]).toString('utf8'));
}

// Busca la llave en las USB conectadas
function leer() {
  for (const u of usbs()) {
    if (!u.tieneLlave) continue;
    try {
      const o = interpretar(fs.readFileSync(u.archivo, 'utf8'));
      const pass = {};
      for (const k of CAMPOS) if (o.pass && typeof o.pass[k] === 'string' && o.pass[k]) pass[k] = o.pass[k];
      return { ok: true, usb: u.nombre, nombre: o.nombre || '', creada: o.creada || null, pass };
    } catch (e) {
      return { ok: false, usb: u.nombre, error: 'La llave de la USB "' + u.nombre + '" tiene un error de formato (revisa comillas y comas): ' + e.message };
    }
  }
  return { ok: false, error: 'No hay llave USB conectada.' };
}

/* ---------- Aviso cuando se conecta o se quita ---------- */
let ultimo = '';
function enviar(canal, d) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(canal, d); }
function estado() {
  const r = leer();
  return r.ok ? { hay: true, usb: r.usb, nombre: r.nombre, campos: Object.keys(r.pass) } : { hay: false, error: r.usb ? r.error : null };
}
function revisar() {
  const e = estado();
  const firma = JSON.stringify(e);
  if (firma === ultimo) return;
  const antes = ultimo ? JSON.parse(ultimo) : null;
  ultimo = firma;
  if (antes && antes.hay !== e.hay) bitacora.registrar('Llave USB', e.hay ? 'Se conectó' : 'Se quitó', e.hay ? e.usb + (e.nombre ? ' · ' + e.nombre : '') : '');
  enviar('llave-estado', e);
}
setInterval(revisar, 2500).unref();

/* ---------- Canales ---------- */
ipcMain.handle('llave-estado', () => estado());
ipcMain.handle('llave-leer', () => {
  const r = leer();
  if (r.ok) bitacora.registrar('Llave USB', 'Se usaron las contraseñas', r.usb + ' · ' + Object.keys(r.pass).join(', '));
  return r;
});
ipcMain.handle('llave-usbs', () => usbs());
ipcMain.handle('llave-crear', (_e, opc) => {
  const o = opc || {};
  const u = usbs().find((x) => x.ruta === o.ruta);
  if (!u) return { ok: false, error: 'Esa USB ya no está conectada.' };
  if (!u.escribible) return { ok: false, error: 'No se puede escribir en la USB "' + u.nombre + '" (¿está protegida contra escritura?).' };
  const pass = {};
  for (const k of CAMPOS) if (o.pass && typeof o.pass[k] === 'string' && o.pass[k]) pass[k] = o.pass[k].slice(0, 300);
  if (!Object.keys(pass).length) return { ok: false, error: 'Escribe al menos una contraseña.' };
  const ruta = path.join(u.ruta, NOMBRE);
  try {
    const tmp = ruta + '.tmp';
    const datos = { nombre: String(o.nombre || '').slice(0, 60) };
    for (const k of CAMPOS) datos[k] = pass[k] || '';
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + '\n');
    fs.renameSync(tmp, ruta);
    try { if (fs.existsSync(path.join(u.ruta, NOMBRE_VIEJO))) fs.unlinkSync(path.join(u.ruta, NOMBRE_VIEJO)); } catch (e) {}
    try { require('child_process').spawn('sync', [], { stdio: 'ignore' }).on('error', () => {}); } catch (e) {}
  } catch (e) { return { ok: false, error: 'No se pudo escribir en la USB: ' + e.message }; }
  bitacora.registrar('Llave USB', 'Creó llave', u.nombre + ' · ' + Object.keys(pass).join(', '));
  ultimo = '';
  revisar();
  return { ok: true, usb: u.nombre, campos: Object.keys(pass) };
});

module.exports = { leer, usbs, NOMBRE };
console.log('[llave] llave USB lista');
