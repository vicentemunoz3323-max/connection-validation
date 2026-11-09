/* ============================================================
   ENGINEOUT · datos del equipo y reporte en PDF
   - Datos del equipo (rack, hostname, IP, usuario)
   - Convierte el reporte (HTML) a PDF y lo guarda en ~/Ghostfish-Logs/engineout/
   Los comandos se corren con la máquina de comandos de main.js (cmds-run).
   ============================================================ */
const { ipcMain, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bitacora = require('./bitacora.js');

const dirReportes = () => bitacora.dir('engineout');

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

/* ---------- Reporte en PDF ---------- */
const nombreSeguro = (t) => String(t || 'reporte').replace(/[^\w.-]+/g, '_').slice(0, 90);

ipcMain.handle('eo-reporte-pdf', async (_e, datos) => {
  let win = null;
  const tmp = path.join(os.tmpdir(), 'engineout_' + process.pid + '_' + Date.now() + '.html');
  try {
    fs.writeFileSync(tmp, String((datos && datos.html) || ''), 'utf8');
    win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: false, contextIsolation: true } });
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      pageSize: 'Letter', printBackground: true, preferCSSPageSize: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 }
    });
    const ruta = path.join(dirReportes(), nombreSeguro(datos && datos.nombre) + '.pdf');
    fs.writeFileSync(ruta, pdf);
    bitacora.registrar('Liberar rack', 'Reporte PDF', ruta);
    if (datos && datos.abrir) shell.openPath(ruta);
    return { ok: true, ruta };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

ipcMain.handle('eo-reporte-abrir', (_e, ruta) => {
  const base = dirReportes();
  const r = ruta && path.resolve(String(ruta));
  if (r && r.startsWith(base) && fs.existsSync(r)) { shell.openPath(r); return true; }
  shell.openPath(base);
  return false;
});
