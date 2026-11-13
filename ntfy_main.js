'use strict';
/* ============================================================
   NOTIFICACIONES AL CELULAR con ntfy.sh (BETA) · proceso principal
   Mismo esquema que ORT Engine: se publica en un "tema" de ntfy y el celular
   suscrito a ese tema recibe el aviso.
   - Se configura con el botón del celular (junto al candado).
   - Se guarda en <userData>/ntfy.json (solo en esta PC, nunca en el repo).
   - Si no hay internet, el aviso se guarda y se reintenta cada minuto (hasta 24 h).
   Eventos: liberar (Liberar rack terminó), daq (canal fuera de rango),
            lock (contraseña incorrecta / bloqueo quitado / desbloqueo),
            testcase (seriales generados), instalador (terminó de instalar).
   ============================================================ */
const { app, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTOS = ['liberar', 'daq', 'lock', 'testcase', 'instalador'];
const BASE = { activo: false, servidor: 'https://ntfy.sh', tema: '', token: '', liberar: true, daq: true, lock: true, testcase: false, instalador: true };
const archivo = () => path.join(app.getPath('userData'), 'ntfy.json');

function leer() {
  try { return { ...BASE, ...JSON.parse(fs.readFileSync(archivo(), 'utf8')) }; } catch (e) { return { ...BASE }; }
}
function limpiar(n) {
  const o = { ...BASE };
  o.activo = !!(n && n.activo);
  o.servidor = String((n && n.servidor) || BASE.servidor).trim().replace(/\/+$/, '').slice(0, 200) || BASE.servidor;
  o.tema = String((n && n.tema) || '').trim().slice(0, 64);
  o.token = String((n && n.token) || '').trim().slice(0, 200);
  for (const k of EVENTOS) o[k] = !!(n && n[k]);
  return o;
}
function guardar(n) {
  const o = limpiar(n);
  fs.mkdirSync(path.dirname(archivo()), { recursive: true });
  fs.writeFileSync(archivo(), JSON.stringify(o, null, 2), { mode: 0o600 });
  return o;
}

async function publicar(n, aviso) {
  const servidor = String(n.servidor || BASE.servidor).trim().replace(/\/+$/, '');
  const tema = String(n.tema || '').trim();
  if (!tema) return { ok: false, mensaje: 'Falta el tema' };
  if (!/^https?:\/\//i.test(servidor)) return { ok: false, mensaje: 'El servidor debe empezar con https://' };
  const headers = { 'Content-Type': 'application/json' };
  if (n.token) headers.Authorization = 'Bearer ' + String(n.token).trim();
  const ctrl = new AbortController();
  const limite = setTimeout(() => ctrl.abort(), 10000);
  try {
    // En JSON: acepta acentos y emojis sin problema
    const r = await fetch(servidor + '/', {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({ topic: tema, title: aviso.title, message: aviso.message, tags: aviso.tags || [], priority: aviso.priority || 3 })
    });
    if (r.ok) return { ok: true };
    const motivos = { 401: 'Token incorrecto o falta token', 403: 'Sin permiso para ese tema', 429: 'Demasiados avisos, espera un momento' };
    return { ok: false, mensaje: motivos[r.status] || 'El servidor respondió ' + r.status };
  } catch (e) {
    return { ok: false, mensaje: e.name === 'AbortError' ? 'Sin respuesta del servidor (10 s)' : 'Sin conexión a internet o servidor no encontrado' };
  } finally { clearTimeout(limite); }
}

// Sin internet: se guarda y se reintenta cada minuto (hasta 24 h, máximo 100)
const pendientes = [];
setInterval(async () => {
  if (!pendientes.length) return;
  const n = leer();
  if (!n.activo || !n.tema) return;
  for (const p of [...pendientes]) {
    if (Date.now() - p.creado > 24 * 3600 * 1000) { pendientes.splice(pendientes.indexOf(p), 1); continue; }
    const r = await publicar(n, p.aviso);
    if (r.ok) pendientes.splice(pendientes.indexOf(p), 1); else break;
  }
}, 60 * 1000).unref();

// Lo usan los módulos del proceso principal y la ventana
async function avisar(tipo, aviso) {
  const n = leer();
  if (!n.activo || !n.tema || !EVENTOS.includes(tipo) || !n[tipo] || !aviso) return { ok: false, omitido: true };
  const a = {
    title: String(aviso.title || 'Connection Validation').slice(0, 120),
    message: String(aviso.message || '').slice(0, 1500) + '\nEquipo: ' + os.hostname(),
    tags: Array.isArray(aviso.tags) ? aviso.tags.slice(0, 5).map(String) : [],
    priority: Math.min(5, Math.max(1, Number(aviso.priority) || 3))
  };
  const r = await publicar(n, a);
  if (!r.ok && pendientes.length < 100) pendientes.push({ aviso: a, creado: Date.now() });
  return r;
}

ipcMain.handle('ntfy-leer', () => leer());
ipcMain.handle('ntfy-guardar', (_e, n) => {
  try {
    const o = guardar(n);
    try { require('./bitacora.js').registrar('Notificaciones', o.activo ? 'Encendió ntfy' : 'Apagó ntfy', o.tema ? 'tema ' + o.tema : ''); } catch (e) {}
    return { ok: true, config: o };
  } catch (e) { return { ok: false, mensaje: e.message }; }
});
// "Enviar prueba" usa lo que esté escrito aunque no se haya guardado
ipcMain.handle('ntfy-prueba', (_e, n) => publicar(limpiar(n), {
  title: 'Connection Validation · prueba',
  message: 'Las notificaciones funcionan ✔\nEquipo: ' + os.hostname(),
  tags: ['iphone'], priority: 3
}));
ipcMain.handle('ntfy-evento', (_e, tipo, aviso) => avisar(tipo, aviso));

module.exports = { avisar, leer, _prueba: { limpiar } };
