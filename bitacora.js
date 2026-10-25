'use strict';
/* ============================================================
   BITÁCORA CENTRAL (proceso principal)
   Todos los logs de la app en una sola carpeta visible del servidor:

     ~/Ghostfish-Logs/
       actividad/          actividad_AAAA-MM-DD.log  ← qué se hizo, quién y cuándo (todo el día en un archivo)
       validacion/         salida de cada "Probar conexión" (rectificadores)
       izumis/             resultado de la revisión de las 16 Izumis
       rectificadores/     cada actualización de rectificadores (comandos y salida)
       testcase/           escaneos, generación y ejecuciones del Test case
       configuracion/      scripts de Configuración (SERVER, JUNIPER, DAQ…)
       chiller/            scripts del chiller monitor
       consolas-izumi/     todo lo que mandó cada Izumi por su consola
       remplazo-izumi/     cada cambio de MAC en el DHCP (antes y después)

   Para cambiar la carpeta:  CV_LOGS_DIR=/ruta  (variable de entorno)
   ============================================================ */
const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.CV_LOGS_DIR || path.join(os.homedir(), 'Ghostfish-Logs');
const CARPETAS = ['actividad', 'validacion', 'izumis', 'rectificadores', 'testcase', 'configuracion', 'chiller', 'server', 'consolas-izumi', 'remplazo-izumi'];

const dos = (n) => String(n).padStart(2, '0');
const fecha = (d = new Date()) => d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate());
const hora = (d = new Date()) => dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds());
// Para nombres de archivo: 2026-10-24_13-05-09
const sello = (d = new Date()) => fecha(d) + '_' + hora(d).replace(/:/g, '-');

// Devuelve la carpeta de una sección (la crea si no existe)
function dir(seccion) {
  const d = path.join(BASE, seccion);
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

// Crea todas las carpetas al abrir la app, para que se vean desde el inicio
function preparar() {
  for (const c of CARPETAS) dir(c);
  try {
    const leeme = path.join(BASE, 'LEEME.txt');
    if (!fs.existsSync(leeme)) {
      fs.writeFileSync(leeme, [
        'Logs de Connection Validation (Ghostfish)',
        '',
        'actividad/        Qué se hizo en la app, con fecha, hora, usuario y equipo. Un archivo por día.',
        'validacion/       Salida de cada "Probar conexión" (rectificadores).',
        'izumis/           Resultado de la revisión de las 16 Izumis (conectada, ocupada, booteando...).',
        'rectificadores/   Cada actualización de rectificadores: comandos y toda su salida.',
        'testcase/         Escaneos, generación y ejecuciones del Test case.',
        'configuracion/    Scripts corridos desde Configuración (SERVER, JUNIPER, DAQ...).',
        'chiller/          Scripts del chiller monitor.',
        'server/           Cada configuración del servidor (todo el flujo o pasos sueltos).',
        'consolas-izumi/   Todo lo que mandó cada Izumi por su consola.',
        'remplazo-izumi/   Cada cambio de MAC en dhcpd.conf / dhcpd6.conf (antes y después).',
        ''
      ].join('\n'));
    }
  } catch (e) {}
}

let quien = '';
function usuarioEquipo() {
  if (quien) return quien;
  let u = process.env.SUDO_USER || process.env.USER || '';
  try { u = u || os.userInfo().username; } catch (e) {}
  quien = (u || 'usuario') + '@' + os.hostname();
  return quien;
}

/* Registra una acción en actividad/actividad_AAAA-MM-DD.log
   2026-10-24 13:05:09 | testusr@ghostfish-ist-flg-054 | RECTIFICADORES | Inició actualización | 3 comandos */
function registrar(seccion, accion, detalle) {
  try {
    const d = new Date();
    const limpiar = (t) => String(t == null ? '' : t).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 2000);
    const linea = [fecha(d) + ' ' + hora(d), usuarioEquipo(), limpiar(seccion).toUpperCase(), limpiar(accion), limpiar(detalle)]
      .filter((x, i) => i < 4 || x).join(' | ') + '\n';
    fs.appendFileSync(path.join(dir('actividad'), 'actividad_' + fecha(d) + '.log'), linea);
  } catch (e) {
    console.log('[bitacora] no se pudo registrar:', e.message);
  }
}

// Guarda un texto completo en un archivo nuevo de la sección; devuelve la ruta
function guardar(seccion, nombre, texto) {
  try {
    const ruta = path.join(dir(seccion), nombre.replace(/[^\w.\-]+/g, '_'));
    fs.writeFileSync(ruta, texto);
    return ruta;
  } catch (e) {
    console.log('[bitacora] no se pudo guardar', nombre + ':', e.message);
    return null;
  }
}

/* ---------- Canales con la ventana ---------- */
ipcMain.handle('bitacora-abrir', async (_e, seccion) => {
  const d = seccion && CARPETAS.includes(seccion) ? dir(seccion) : (preparar(), BASE);
  const err = await shell.openPath(d);
  return err ? { ok: false, error: err, ruta: d } : { ok: true, ruta: d };
});
ipcMain.handle('bitacora-ruta', () => BASE);
// Acciones que solo ve la ventana (cargar un .txt, activar el switch, etc.)
ipcMain.handle('bitacora-registrar', (_e, seccion, accion, detalle) => {
  registrar(String(seccion || 'APP').slice(0, 40), String(accion || '').slice(0, 300), detalle);
  return true;
});

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;   // segunda copia que se va a cerrar: no cuenta
  preparar();
  registrar('App', 'Abrió la app', 'v' + app.getVersion());
});
app.on('before-quit', () => { if (app.hasSingleInstanceLock()) registrar('App', 'Cerró la app'); });

module.exports = { BASE, dir, registrar, guardar, sello, fecha, hora };
console.log('[bitacora] logs en', BASE);
