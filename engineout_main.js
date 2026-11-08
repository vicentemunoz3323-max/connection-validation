/* ============================================================
   ENGINEOUT · reporte y correo
   - Datos del equipo (rack, hostname, IP, usuario)
   - Guarda el reporte en ~/Ghostfish-Logs/engineout/
   - Manda el reporte por correo (SMTP propio, sin paquetes extra)
     o lo abre en el programa de correo de la PC (mailto)
   Los comandos se corren con la máquina de comandos de main.js (cmds-run).
   ============================================================ */
const { app, ipcMain, shell, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const bitacora = require('./bitacora.js');

const dirReportes = () => bitacora.dir('engineout');
const rutaConfig = () => path.join(app.getPath('userData'), 'engineout_correo.json');

/* ---------- Datos del equipo ---------- */
function ipDelEquipo() {
  const todas = [];
  for (const [nombre, lista] of Object.entries(os.networkInterfaces())) {
    for (const i of lista || []) if (i.family === 'IPv4' && !i.internal) todas.push({ nombre, ip: i.address });
  }
  const sfc = todas.find((x) => x.ip.startsWith('172.24.')) || todas.find((x) => !x.ip.startsWith('10.')) || todas[0];
  return sfc ? sfc.ip : '';
}

function rackDelEquipo(hostname, ip) {
  // 1) lo que guardó el script de configuración
  try {
    const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'provisioning_state.json'), 'utf8'));
    const r = st && (st.config || st).rack_number;
    if (r !== undefined && r !== null && String(r).trim()) return String(r).trim();
  } catch (e) {}
  // 2) el hostname: ghostfish-ist-flg-012 → 12
  const m = /(\d{1,3})$/.exec(hostname || '');
  if (m) return String(parseInt(m[1], 10));
  // 3) la IP: 172.24.125.(rack + 99)
  const mi = /^172\.24\.125\.(\d+)$/.exec(ip || '');
  if (mi && Number(mi[1]) > 99) return String(Number(mi[1]) - 99);
  return '';
}

ipcMain.handle('eo-info', () => {
  const hostname = os.hostname();
  const ip = ipDelEquipo();
  let usuario = '';
  try { usuario = os.userInfo().username; } catch (e) {}
  return { hostname, ip, rack: rackDelEquipo(hostname, ip), usuario };
});

/* ---------- Reporte ---------- */
const nombreSeguro = (t) => String(t || 'reporte').replace(/[^\w.-]+/g, '_').slice(0, 80);

ipcMain.handle('eo-reporte-guardar', (_e, datos) => {
  try {
    const ruta = path.join(dirReportes(), nombreSeguro(datos && datos.nombre) + '.html');
    fs.writeFileSync(ruta, String((datos && datos.html) || ''), 'utf8');
    if (datos && datos.texto) fs.writeFileSync(ruta.replace(/\.html$/, '.txt'), String(datos.texto), 'utf8');
    bitacora.registrar('EngineOut', 'Reporte guardado', ruta);
    return { ok: true, ruta };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('eo-reporte-abrir', (_e, ruta) => {
  const base = dirReportes();
  const r = ruta && path.resolve(String(ruta));
  if (r && r.startsWith(base) && fs.existsSync(r)) { shell.openPath(r); return true; }
  shell.openPath(base);
  return false;
});

/* ---------- Configuración del correo ---------- */
function leerConfig() {
  try { return JSON.parse(fs.readFileSync(rutaConfig(), 'utf8')) || {}; } catch (e) { return {}; }
}
function cifrar(t) {
  if (!t) return '';
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(t).toString('base64'); } catch (e) {}
  return 'b64:' + Buffer.from(t, 'utf8').toString('base64');
}
function descifrar(t) {
  if (!t) return '';
  try {
    if (t.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(t.slice(4), 'base64'));
    if (t.startsWith('b64:')) return Buffer.from(t.slice(4), 'base64').toString('utf8');
  } catch (e) {}
  return '';
}
const configPublica = (c) => ({
  host: c.host || '', puerto: c.puerto || 587, seguridad: c.seguridad || 'starttls',
  usuario: c.usuario || '', de: c.de || '', para: c.para || '', hayPass: !!c.pass
});

ipcMain.handle('eo-correo-config', () => configPublica(leerConfig()));
ipcMain.handle('eo-correo-config-guardar', (_e, n) => {
  const c = leerConfig();
  const nuevo = {
    host: String(n.host || '').trim(),
    puerto: Number(n.puerto) || 587,
    seguridad: ['ssl', 'starttls', 'ninguna'].includes(n.seguridad) ? n.seguridad : 'starttls',
    usuario: String(n.usuario || '').trim(),
    de: String(n.de || '').trim(),
    para: String(n.para || '').trim(),
    pass: n.borrarPass ? '' : n.pass ? cifrar(String(n.pass)) : c.pass || ''
  };
  try {
    fs.writeFileSync(rutaConfig(), JSON.stringify(nuevo, null, 2), { mode: 0o600 });
    return { ok: true, config: configPublica(nuevo) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------- SMTP ---------- */
const listaCorreos = (t) => String(t || '').split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(x));
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
const b64Lineas = (buf) => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
const encabezado = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : '=?UTF-8?B?' + b64(t) + '?=');

function armarMensaje({ de, para, asunto, texto, html, adjuntos }) {
  const mezcla = 'mix_' + crypto.randomBytes(8).toString('hex');
  const alt = 'alt_' + crypto.randomBytes(8).toString('hex');
  const dominio = (de.split('@')[1] || 'localhost').replace(/[^\w.-]/g, '');
  const partes = [
    'From: ' + encabezado('Connection Validation') + ' <' + de + '>',
    'To: ' + para.join(', '),
    'Subject: ' + encabezado(asunto),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@' + dominio + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + mezcla + '"',
    '',
    '--' + mezcla,
    'Content-Type: multipart/alternative; boundary="' + alt + '"',
    '',
    '--' + alt,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lineas(Buffer.from(texto || '', 'utf8')),
    '--' + alt,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lineas(Buffer.from(html || '', 'utf8')),
    '--' + alt + '--',
    ''
  ];
  for (const a of adjuntos || []) {
    partes.push('--' + mezcla,
      'Content-Type: ' + (a.tipo || 'application/octet-stream') + '; name="' + a.nombre + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + a.nombre + '"',
      '',
      b64Lineas(a.datos));
  }
  partes.push('--' + mezcla + '--', '');
  return partes.join('\r\n');
}

function enviarSmtp(cfg, mensaje, de, para) {
  return new Promise((resolve, reject) => {
    let sock = null, buf = '', espera = null, terminado = false;
    const fin = (err) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      try { sock && sock.end(); } catch (e) {}
      err ? reject(err) : resolve();
    };
    const reloj = setTimeout(() => fin(new Error('El servidor de correo no contestó (30 s). Revisa servidor, puerto y que la PC tenga internet.')), 30000);

    let acum = [];
    const pendientes = [];
    const alLeer = (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const mm = /^(\d{3})([ -]?)(.*)$/.exec(l);
        if (!mm) continue;
        acum.push(mm[3]);
        if (mm[2] === '-') continue;   // respuesta de varias líneas: falta
        const r = { cod: Number(mm[1]), texto: acum.join('\n') };
        acum = [];
        const e = espera; espera = null;
        if (e) e(r); else pendientes.push(r);
      }
    };
    const leer = () => (pendientes.length ? Promise.resolve(pendientes.shift()) : new Promise((r) => { espera = r; }));
    const enviar = (t) => sock.write(t + '\r\n');
    const pedir = async (t, ok, quePaso) => {
      const p = leer();
      enviar(t);
      const r = await p;
      if (!ok.includes(r.cod)) throw new Error((quePaso || 'El servidor rechazó') + ': ' + r.cod + ' ' + r.texto.split('\n').pop());
      return r;
    };
    const conectar = (s) => {
      sock = s;
      sock.on('data', alLeer);
      sock.on('error', (e) => fin(new Error('No se pudo conectar al servidor de correo: ' + e.message)));
    };

    (async () => {
      const host = cfg.host, puerto = Number(cfg.puerto) || 587;
      const primero = leer();
      if (cfg.seguridad === 'ssl') conectar(tls.connect({ host, port: puerto, servername: host }));
      else conectar(net.connect({ host, port: puerto }));
      const hola = await primero;
      if (hola.cod !== 220) throw new Error('El servidor de correo no saludó: ' + hola.cod + ' ' + hola.texto);
      const yo = (os.hostname() || 'localhost').replace(/[^\w.-]/g, '') || 'localhost';
      let ehlo = await pedir('EHLO ' + yo, [250], 'EHLO');
      if (cfg.seguridad === 'starttls') {
        if (!/STARTTLS/i.test(ehlo.texto)) throw new Error('El servidor no acepta STARTTLS: usa SSL (puerto 465) o "sin cifrar".');
        await pedir('STARTTLS', [220], 'STARTTLS');
        sock.removeListener('data', alLeer);
        await new Promise((r, j) => {
          const t = tls.connect({ socket: sock, servername: host }, r);
          t.on('error', j);
          sock = t;
        });
        sock.on('data', alLeer);
        sock.on('error', (e) => fin(new Error('Error de conexión segura: ' + e.message)));
        ehlo = await pedir('EHLO ' + yo, [250], 'EHLO');
      }
      if (cfg.usuario) {
        const pass = descifrar(cfg.pass);
        if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.texto)) {
          await pedir('AUTH PLAIN ' + b64('\0' + cfg.usuario + '\0' + pass), [235], 'Usuario o contraseña del correo incorrectos');
        } else {
          await pedir('AUTH LOGIN', [334], 'AUTH');
          await pedir(b64(cfg.usuario), [334], 'Usuario del correo');
          await pedir(b64(pass), [235], 'Usuario o contraseña del correo incorrectos');
        }
      }
      await pedir('MAIL FROM:<' + de + '>', [250], 'Remitente rechazado');
      for (const p of para) await pedir('RCPT TO:<' + p + '>', [250, 251], 'Destinatario rechazado (' + p + ')');
      await pedir('DATA', [354], 'DATA');
      const cuerpo = mensaje.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      await pedir(cuerpo + '\r\n.', [250], 'El servidor no aceptó el mensaje');
      try { enviar('QUIT'); } catch (e) {}
      fin();
    })().catch(fin);
  });
}

ipcMain.handle('eo-correo-enviar', async (_e, d) => {
  const cfg = leerConfig();
  const para = listaCorreos((d && d.para) || cfg.para);
  if (!cfg.host) return { ok: false, error: 'Falta configurar el servidor de correo (abajo, en "Configurar correo").' };
  if (!para.length) return { ok: false, error: 'Escribe al menos un correo destino válido.' };
  const de = listaCorreos(cfg.de || cfg.usuario)[0];
  if (!de) return { ok: false, error: 'Falta el correo remitente ("Enviar desde").' };
  const adjuntos = [];
  try {
    if (d.html) adjuntos.push({ nombre: nombreSeguro(d.nombre || 'reporte_engineout') + '.html', tipo: 'text/html; charset=utf-8', datos: Buffer.from(d.html, 'utf8') });
    const log = d.logPath && path.resolve(String(d.logPath));
    if (log && log.startsWith(dirReportes()) && fs.existsSync(log) && fs.statSync(log).size < 5 * 1024 * 1024) {
      adjuntos.push({ nombre: path.basename(log), tipo: 'text/plain; charset=utf-8', datos: fs.readFileSync(log) });
    }
  } catch (e) {}
  try {
    const msg = armarMensaje({ de, para, asunto: String(d.asunto || 'Reporte EngineOut'), texto: d.texto, html: d.html, adjuntos });
    await enviarSmtp(cfg, msg, de, para);
    bitacora.registrar('EngineOut', 'Reporte enviado por correo', para.join(', '));
    return { ok: true, para };
  } catch (e) {
    bitacora.registrar('EngineOut', 'No se pudo enviar el correo', e.message);
    return { ok: false, error: e.message };
  }
});

// Abre el programa de correo de la PC con el reporte en texto
ipcMain.handle('eo-correo-mailto', (_e, d) => {
  const para = listaCorreos(d && d.para).join(',');
  let cuerpo = String((d && d.texto) || '');
  if (cuerpo.length > 1800) cuerpo = cuerpo.slice(0, 1800) + '\n…(el reporte completo está en ~/Ghostfish-Logs/engineout)';
  const url = 'mailto:' + encodeURIComponent(para).replace(/%2C/g, ',') + '?subject=' + encodeURIComponent(String((d && d.asunto) || 'Reporte EngineOut')) + '&body=' + encodeURIComponent(cuerpo);
  shell.openExternal(url).catch(() => {});
  return true;
});

module.exports = { armarMensaje, enviarSmtp, listaCorreos };
