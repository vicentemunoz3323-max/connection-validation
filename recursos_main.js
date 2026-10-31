'use strict';
/* ============================================================
   RECURSOS (proceso principal)
   Corre en segundo plano el comando de CPU / RAM / DISCO y le pasa
   los porcentajes a la ventana Recursos. Solo mide mientras esa
   ventana está abierta (la ventana lo pide cada 2 s).
   ============================================================ */
const { ipcMain, app } = require('electron');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const COMANDO = 'echo -e "CPU: $(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk \'{print 100 - $1"%"}\') | RAM: $(free | grep Mem | awk \'{print int($3/$2 * 100)"%"}\') | DISCO: $(df -h / | awk \'NR==2 {print $5}\')"';

let enCurso = null;

// "CPU: 12.3% | RAM: 45% | DISCO: 67%"  →  { cpu: 12.3, ram: 45, disco: 67 }
function interpretar(t) {
  const num = (k) => {
    const m = String(t).match(new RegExp(k + ':\\s*([0-9]+(?:[.,][0-9]+)?)\\s*%'));
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 10) / 10)) : null;
  };
  return { cpu: num('CPU'), ram: num('RAM'), disco: num('DISCO') };
}

function medir() {
  if (enCurso) return enCurso;   // si la ventana pide otra antes de terminar, comparte la misma medición
  enCurso = new Promise((resolve) => {
    // LC_ALL=C: top y df con punto decimal y en inglés ("Cpu(s)", "id"), como espera el comando
    execFile('bash', ['-c', COMANDO], { timeout: 8000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, out, errOut) => {
      enCurso = null;
      const texto = String(out || '').trim();
      const v = interpretar(texto);
      if (err && v.cpu == null && v.ram == null && v.disco == null) {
        return resolve({ ok: false, error: String(errOut || err.message).trim().split('\n').pop(), texto, hora: Date.now() });
      }
      resolve({ ok: true, ...v, texto, hora: Date.now() });
    });
  });
  return enCurso;
}

ipcMain.handle('rec-medir', () => medir());

/* ---------- Consumo de esta app (todos sus procesos de Electron) ---------- */
let discoCache = { kb: null, hora: 0 }, discoMidiendo = false;
function medirDiscoApp() {
  if (discoMidiendo || Date.now() - discoCache.hora < 60000) return;   // el disco se mide cada minuto (du es lento)
  discoMidiendo = true;
  const carpetas = [app.getAppPath(), app.getPath('userData'), path.join(os.homedir(), 'Ghostfish-Logs')];
  execFile('du', ['-skc', ...carpetas], { timeout: 20000 }, (err, out) => {
    discoMidiendo = false;
    const m = String(out || '').match(/(\d+)\s+total\s*$/m);
    discoCache = { kb: m ? +m[1] : discoCache.kb, hora: Date.now() };
  });
}
function consumoApp() {
  medirDiscoApp();
  let cpu = 0, memKb = 0, procesos = 0;
  try {
    for (const m of app.getAppMetrics()) { procesos++; cpu += (m.cpu && m.cpu.percentCPUUsage) || 0; memKb += (m.memory && m.memory.workingSetSize) || 0; }
  } catch (e) {}
  const nucleos = (os.cpus() || []).length || 1;
  const totalMemKb = os.totalmem() / 1024;
  return {
    ok: true, procesos,
    cpu: Math.min(100, Math.round((cpu / nucleos) * 10) / 10),          // % del CPU total del servidor
    ramMb: Math.round(memKb / 1024), ram: Math.round((memKb / totalMemKb) * 1000) / 10,   // % de la RAM total
    discoMb: discoCache.kb != null ? Math.round(discoCache.kb / 1024) : null,
    discoTotalMb: (() => { try { const f = require('fs').statfsSync('/'); return Math.round(f.blocks * f.bsize / 1048576); } catch (e) { return null; } })(),
    hora: Date.now()
  };
}
ipcMain.handle('rec-app', () => consumoApp());


module.exports = { medir, interpretar, COMANDO };
console.log('[recursos] medición de CPU / RAM / DISCO lista');
