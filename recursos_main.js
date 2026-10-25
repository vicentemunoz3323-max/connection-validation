'use strict';
/* ============================================================
   RECURSOS (proceso principal)
   Corre en segundo plano el comando de CPU / RAM / DISCO y le pasa
   los porcentajes a la ventana Recursos. Solo mide mientras esa
   ventana está abierta (la ventana lo pide cada 2 s).
   ============================================================ */
const { ipcMain } = require('electron');
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

module.exports = { medir, interpretar, COMANDO };
console.log('[recursos] medición de CPU / RAM / DISCO lista');
