#!/usr/bin/env python3
"""UUT_case · Generar automatico (Connection Validation)

Lee la EEPROM de los 16 slots (ping + consola del ZPE + ssh al BMC + hexdump),
saca el numero de parte (P/N) y el serial (S/N) y escribe el archivo UUT_case.
Sin menu y sin preguntas: la app lo corre con el boton "Generar" y llena la tabla.

    python3 uut_case.py --generar --archivo ~/UUT_case
    python3 uut_case.py --slots 1-4,9        (solo esos slots; los demas se dejan como estaban)

Por cada slot imprime una linea "@@SLOT {json}" que la app usa para pintar la tabla en vivo.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

# ---------- Valores (los mismos del script original) ----------
NOMBRE_ARCHIVO = "UUT_case"
RUTA_BASE = "~/viper-test/opentest/tools/ot_regression.py"
NUM_SLOTS = 16
ZPE_IP = os.environ.get("CV_ZPE_IP", "10.0.0.253")
ZPE_PUERTO_BASE = int(os.environ.get("CV_ZPE_PUERTO_BASE", "7000"))   # el slot N es el puerto 7000 + N
IP_SLOT = os.environ.get("CV_IP_SLOT", "10.0.0.{}")
LOGIN = "root"
BMC_SSH = "ssh root@fe80::21a:11ff:fe16:fead%gbmcbr"
BMC_PASSWORD = "0penBmc"
COMANDO_EEPROM = "hexdump -C -n256 /sys/bus/i2c/drivers/at24/150-0050/eeprom"
PING_SEGUNDOS = int(os.environ.get("CV_PING_SEGUNDOS", "60"))   # cuanto se insiste con el ping por slot (igual que el original)
A_LA_VEZ = 4                # slots que se leen al mismo tiempo (el original iba de uno en uno: hasta 16 min)
PARTES_CONOCIDAS = ("1227014", "1231778")

_imprimir = threading.Lock()

def decir(texto):
    with _imprimir:
        print(texto, flush=True)

def avisar(**datos):
    decir("@@SLOT " + json.dumps(datos, ensure_ascii=False))


# ---------- Telnet minimo (telnetlib ya no existe en Python 3.13) ----------
IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240

class Consola:
    def __init__(self, host, puerto, timeout=5):
        self.s = socket.create_connection((host, puerto), timeout=timeout)
        self.buf = b""

    def _leer(self, timeout):
        self.s.settimeout(max(0.05, timeout))
        try:
            data = self.s.recv(4096)
        except socket.timeout:
            return None
        if not data:
            raise EOFError("el ZPE cerro la conexion")
        limpio, i = bytearray(), 0
        while i < len(data):
            b = data[i]
            if b == IAC and i + 1 < len(data):
                cmd = data[i + 1]
                if cmd in (DO, DONT, WILL, WONT) and i + 2 < len(data):
                    opt = data[i + 2]
                    if cmd in (DO, DONT):
                        self.s.sendall(bytes([IAC, WONT, opt]))
                    else:
                        self.s.sendall(bytes([IAC, DONT, opt]))
                    i += 3
                    continue
                if cmd == SB:
                    fin = data.find(bytes([IAC, SE]), i)
                    i = fin + 2 if fin >= 0 else len(data)
                    continue
                if cmd == IAC:
                    limpio.append(IAC)
                i += 2
                continue
            limpio.append(b)
            i += 1
        return bytes(limpio)

    def esperar(self, patrones, timeout):
        """Espera hasta que salga alguno de los patrones (regex de bytes). Regresa (indice, texto)."""
        limite = time.time() + timeout
        while True:
            for k, p in enumerate(patrones):
                m = re.search(p, self.buf)
                if m:
                    texto = self.buf[:m.end()]
                    self.buf = self.buf[m.end():]
                    return k, texto.decode("utf-8", "ignore")
            quedan = limite - time.time()
            if quedan <= 0:
                texto, self.buf = self.buf, b""
                return -1, texto.decode("utf-8", "ignore")
            nuevo = self._leer(min(quedan, 1.0))
            if nuevo:
                self.buf += nuevo

    def escribir(self, texto):
        self.s.sendall(texto.encode() + b"\r")

    def cerrar(self):
        try:
            self.s.close()
        except Exception:
            pass


# ---------- Lectura de la EEPROM ----------
def ping_unidad(n):
    """Ping al slot, insistiendo hasta PING_SEGUNDOS."""
    fin = time.time() + PING_SEGUNDOS
    while time.time() < fin:
        try:
            r = subprocess.run(["ping", "-c", "1", "-W", "2", IP_SLOT.format(n)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            raise RuntimeError("no esta el comando ping (sudo apt install iputils-ping)")
        if r.returncode == 0:
            return True
        time.sleep(1)
    return False

def texto_de_hexdump(salida):
    """Arma el texto de la EEPROM a partir de los bytes del hexdump (el serial puede venir partido en 2 renglones)."""
    bytes_ = []
    for linea in salida.splitlines():
        m = re.match(r"^\s*[0-9a-f]{6,8}\s+((?:[0-9a-f]{2}\s+){1,16})", linea, re.I)
        if m:
            bytes_ += [int(h, 16) for h in m.group(1).split() if re.fullmatch(r"[0-9a-f]{2}", h, re.I)]
    return "".join(chr(b) if 32 <= b < 127 else " " for b in bytes_)

def extraer_parte_serial(salida):
    texto = texto_de_hexdump(salida)
    todo = texto + "\n" + salida
    serial = re.search(r"FLG\d{4}-?\d{5}", todo)
    parte = re.search(r"\b(" + "|".join(PARTES_CONOCIDAS) + r")\b", todo) or re.search(r"(?:^|[^0-9])(\d{7})(?![0-9])", texto)
    return (parte.group(1) if parte else ""), (serial.group(0) if serial else "")

RX_LOGIN = rb"login:\s*$"
RX_SHELL = rb"\(none\):~#\s*$|:~#\s*$"
RX_YESNO = rb"\(yes/no(/\[fingerprint\])?\)\?\s*$"
RX_PASS = rb"[Pp]assword:\s*$"
RX_BMC = rb"root@ghostlite[^\n]*[#$]\s*$"
RX_NEGADO = rb"Permission denied|Connection refused|No route to host|Network is unreachable"

def leer_slot(n):
    """Regresa (parte, serial, motivo_si_fallo)."""
    try:
        tn = Consola(ZPE_IP, ZPE_PUERTO_BASE + n, timeout=5)
    except Exception as e:
        return "", "", f"no abrio la consola del ZPE ({ZPE_IP}:{ZPE_PUERTO_BASE + n}): {e}"
    try:
        tn.escribir("")
        mando_ssh = mando_pass = False
        limite = time.time() + 45
        while True:
            if time.time() > limite:
                return "", "", "no se llego al BMC"
            k, txt = tn.esperar([RX_BMC, RX_YESNO, RX_PASS, RX_LOGIN, RX_NEGADO, RX_SHELL], 12 if mando_ssh else 4)
            if k == 0:
                break
            if k == 1:
                tn.escribir("yes"); continue
            if k == 2:
                if not mando_ssh:
                    tn.escribir(LOGIN); continue
                if mando_pass:
                    return "", "", "el BMC rechazo la contrasena"
                mando_pass = True
                tn.escribir(BMC_PASSWORD); continue
            if k == 3:
                tn.escribir(LOGIN); continue
            if k == 4:
                return "", "", "fallo el ssh al BMC: " + txt.strip().splitlines()[-1][:80]
            if k == 5:
                if mando_ssh and mando_pass:
                    return "", "", "despues del ssh no salio el prompt del BMC"
                mando_ssh = True
                tn.escribir(BMC_SSH); continue
            tn.escribir("")   # sin respuesta: Enter
        # hexdump entre marcas para saber donde empieza y termina
        tn.escribir("echo __EE''INI__; " + COMANDO_EEPROM + "; echo __EE''FIN__")
        _, salida = tn.esperar([rb"__EEFIN__\s*\r?\n"], 10)
        if "__EEINI__" in salida:
            salida = salida.split("__EEINI__", 1)[1]
        salida = salida.split("__EEFIN__", 1)[0]
        tn.escribir("exit")
        tn.esperar([RX_SHELL], 2)
        tn.escribir("exit")
        parte, serial = extraer_parte_serial(salida)
        if parte or serial:
            return parte, serial, ""
        if re.search(r"No such file|cannot open|Permission denied", salida, re.I):
            return "", "", "no se pudo leer la EEPROM"
        return "", "", "la EEPROM no trae serial FLG"
    except Exception as e:
        return "", "", str(e)
    finally:
        tn.cerrar()

def procesar(n):
    try:
        return _procesar(n)
    except Exception as e:   # un slot con problema no tumba a los demas
        decir(f"Slot {n:2d}: FAIL -> {e}")
        avisar(n=n, estado="fail", msg=str(e)[:120])
        return n, "", ""

def _procesar(n):
    avisar(n=n, estado="verificando", msg="Verificando…")
    if not ping_unidad(n):
        decir(f"Slot {n:2d}: FAIL -> Sin respuesta (vacio o apagado).")
        avisar(n=n, estado="fail", msg="Sin respuesta")
        return n, "", ""
    parte, serial, motivo = leer_slot(n)
    if parte or serial:
        decir(f"Slot {n:2d}: SUCCESS -> Parte: {parte}, Serial: {serial}")
        avisar(n=n, estado="ok", msg="SUCCESS", parte=parte, serial=serial)
    else:
        decir(f"Slot {n:2d}: FAIL -> Responde pero no se extrajeron datos ({motivo}).")
        avisar(n=n, estado="fail", msg="Sin datos: " + motivo)
    return n, parte, serial


# ---------- Archivo UUT_case ----------
def leer_archivo(ruta):
    slots = [{"parte": "", "serial": ""} for _ in range(NUM_SLOTS)]
    if os.path.exists(ruta):
        patron = re.escape(RUTA_BASE) + r"\s+(\d+)\s+(\S+)\s+(\S+)"
        with open(ruta, encoding="utf-8") as f:
            for linea in f:
                m = re.search(patron, linea)
                if m and 1 <= int(m.group(1)) <= NUM_SLOTS:
                    i = int(m.group(1)) - 1
                    slots[i]["parte"] = "" if m.group(2) == "CORRIJA_PARTE" else m.group(2)
                    slots[i]["serial"] = "" if m.group(3) == "CORRIJA_SERIAL" else m.group(3)
    return slots

def guardar_archivo(ruta, slots):
    lineas = [f"{RUTA_BASE} {i} {s['parte'] or 'CORRIJA_PARTE'} {s['serial'] or 'CORRIJA_SERIAL'} 0 10"
              for i, s in enumerate(slots, start=1)]
    os.makedirs(os.path.dirname(os.path.abspath(ruta)), exist_ok=True)
    with open(ruta, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\n\n" + " &&\n".join(lineas) + "\n")
    os.chmod(ruta, 0o755)

def slots_de(texto):
    elegidos = set()
    for parte in (texto or "").split(","):
        parte = parte.strip()
        if re.fullmatch(r"\d+-\d+", parte):
            a, b = map(int, parte.split("-"))
            elegidos.update(range(min(a, b), max(a, b) + 1))
        elif parte.isdigit():
            elegidos.add(int(parte))
    return sorted(s for s in elegidos if 1 <= s <= NUM_SLOTS)

def main():
    ap = argparse.ArgumentParser(description="Genera UUT_case leyendo la EEPROM de los 16 slots")
    ap.add_argument("--generar", action="store_true", help="(la app lo manda; es lo unico que hace este script)")
    ap.add_argument("--archivo", default=NOMBRE_ARCHIVO, help="donde escribir UUT_case")
    ap.add_argument("--slots", help="solo estos slots (ej. 1-4,9); los demas se quedan como estaban")
    args = ap.parse_args()

    ruta = os.path.expanduser(args.archivo)
    nums = slots_de(args.slots) if args.slots else list(range(1, NUM_SLOTS + 1))
    if not nums:
        decir("[ERROR] No hay slots validos (1-16).")
        sys.exit(2)
    slots = leer_archivo(ruta) if args.slots else [{"parte": "", "serial": ""} for _ in range(NUM_SLOTS)]

    decir(f"--- Generando {NOMBRE_ARCHIVO} automaticamente ({len(nums)} slot(s), {A_LA_VEZ} a la vez) ---")
    inicio = time.time()
    with ThreadPoolExecutor(max_workers=A_LA_VEZ) as pool:
        for n, parte, serial in pool.map(procesar, nums):
            slots[n - 1] = {"parte": parte, "serial": serial}

    guardar_archivo(ruta, slots)
    con = [f"{i}={s['parte']}/{s['serial']}" for i, s in enumerate(slots, start=1) if s["serial"] or s["parte"]]
    decir(f"[EXITO] Archivo '{ruta}' guardado · {len(con)} de {NUM_SLOTS} slots con unidad · {time.time() - inicio:.0f} s")
    if con:
        decir("        " + ", ".join(con))

if __name__ == "__main__":
    main()
