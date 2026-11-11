#!/usr/bin/env python3
import json
import os
import sys
import subprocess
import re
try:
    import pexpect
except ImportError:   # --lista/--estado funcionan sin pexpect; los pasos que lo usan avisan qué instalar
    class _SinPexpect:
        def __getattr__(self, nombre):
            raise RuntimeError("pexpect no esta instalado: corre 'sudo apt install python3-pexpect' y vuelve a intentar.")
        def __bool__(self):
            return False
    pexpect = _SinPexpect()
import shutil
import time
import select
import atexit
import uuid
import getpass
import argparse

# ==============================================================================
# CONNECTION VALIDATION (app) · config_engine.py (antes gf_provisioning.py)
#
#   Tres configuraciones independientes (cada una con sus pasos y palomitas):
#     --grupo server    Servidor ABMX (red, seguridad, Ansible, DHCP, netplan...)
#     --grupo equipos   Juniper y ZPE por cable de consola
#     --grupo tross     VRMU util, MAC del Tross y las 13 etapas del Tross
#     --paso NOMBRE     corre solo ese paso (le quita la palomita antes)
#     --lista           imprime los pasos en JSON
#     --estado          imprime las palomitas en JSON
#
#   - Todo lo que antes estaba escrito en el codigo (IPs, ligas, nombres de
#     archivos, md5, versiones, puertos, contrasenas de los equipos) sale de
#     CFG. La app lo guarda en valores.json (GF_CONFIG) y se cambia desde la
#     pestana "Valores", sin tocar el codigo.
#   - Contrasenas de sudo / vault / mirror: por variables de entorno
#     (GF_SUDO_PASS, GF_VAULT_PASS, GF_MIRROR_PASS). En terminal se piden.
#     Ya no se guardan en engine_flags.json.
#   - Con GF_APP=1 el script avisa a la app con lineas "@@GF {json}" y le pide
#     respuestas (rack, cables, MAC, reinicios...) por la entrada estandar.
# ==============================================================================
CFG_DEFECTO = {
    # --- General ---
    "state_file": "engine_flags.json",            # banderas del servidor y de Juniper/ZPE (en el home)
    "tross_state_file": "engine_flags_tross.json",  # banderas del Tross (en el home)
    "red_base": "172.24.125.",                    # IP del servidor = red_base + (rack + suma_rack)
    "suma_rack": 99,
    "hostname_prefijo": "ghostfish-ist-flg-",
    "gateway": "172.24.125.1",
    "dns": "8.8.8.8",
    "iface_sfc": "eno1",
    # --- Servidor ---
    "mirror_ip": "172.24.125.2",
    "mirror_user": "testusr",
    "repo_security": "https://mfg-partners.googlesource.com/security-hardened-image",
    "repo_lego": "https://mfg-partners.googlesource.com/lego-infra",
    "crowdstrike_tag": "Flex_Guadalajara_PROD",
    "apt_keyserver": "hkp://keyserver.ubuntu.com:80",
    "apt_key_id": "32EE5355A6BC6E42",
    "chrome_key_url": "https://dl.google.com/linux/linux_signing_key.pub",
    "chrome_repo": "http://dl.google.com/linux/chrome/deb/",
    "nomachine_url": "https://download.nomachine.com/download/9.8/Linux/nomachine_9.8.2_1_amd64.deb",
    "apt_mirrors": "http://us.archive.ubuntu.com/ubuntu/, http://archive.ubuntu.com/ubuntu/, http://mirrors.edge.kernel.org/ubuntu/, http://mirror.math.princeton.edu/pub/ubuntu/, http://azure.archive.ubuntu.com/ubuntu/",
    "python_ansible": "python3.10",
    "setuptools_version": "setuptools<70.0.0",
    "iface_test": "ens4f0",
    "iface_test2": "ens4f1",
    "test_network": "Test Network",
    "dhcp_host": "172.24.125.136",
    "dhcp_user": "testusr",
    "goss_url": "https://goss.rocks/install",
    "tools_host": "172.24.125.174",
    "tools_files": "U22Tocinos",                 # paso 16: solo se descarga U22Tocinos
    "reinicio_min": 5,                            # minutos para reiniciar solo al terminar
    # --- Juniper y ZPE ---
    "consolas": "/dev/ttyUSB0, /dev/ttyUSB1",
    "juniper_baud": 9600,
    "juniper_version": "20.2R2.11",
    "juniper_pass": "",                           # contrasena de root que se le pone al Juniper
    "zpe_baud": 115200,
    "zpe_ip": "10.0.0.253",
    "zpe_user": "admin",
    "zpe_pass": "",
    "zpe_script_dir": "lego-infra/lego_setup/lego_zpe_console_server",
    "zpe_script": "lego_config_zpe_allports.sh",
    # --- Tross ---
    "vrmu_host": "172.24.125.172",
    "vrmu_items": "viperfish-dvc, vrmu_util, ledare_1_*, FWContainer_EN_3_AP_00_02_00_09.bin",
    "tross_ip": "10.0.0.251",
    "tross_netmask": "255.255.0.0",
    "tftp_server": "10.0.0.254",
    "zpe_puerto_tross": 7017,
    "tross_user": "root",
    "tross_pass": "",
    "uboot_file": "tross/uboot_planet-hurricane3.bin",
    "uboot_flash": "MX25L12805",
    "kernel_file": "tross/combined.uImage",
    "kernel_version": "4.19.238-planet-hurricane3 #1",
    "imageset_file": "tross/imageset.tgz",
    "imageset_md5": "3e52decb2b76aa84f83c5ae97e520c77",
    "imager_md5": "142c29970d23c3e4819f144812a64b79",
    "zpe_eth1_bitmask": 8,
    "zpe_gateway": "10.0.0.254",
    "leases_file": "/mnt/region_config/dhcpd/dhcpd.rymden.leases",
    "mac_offset": 2,
    "ledare_prefix": "ledare_1_8_5",
    "ledare_version": "1.8.5",
    "fw_container": "FWContainer_EN_3_AP_00_02_00_09.bin",
    "espera_flash_min": 10,
    "voltaje_min": 50,
    "secuencia_voltaje": "45:100:15",
    "secuencia_min": 40,
    "secuencia_max": 50,
}
CFG = dict(CFG_DEFECTO)
try:
    if os.environ.get("GF_CONFIG") and os.path.exists(os.environ["GF_CONFIG"]):
        with open(os.environ["GF_CONFIG"], encoding="utf-8") as _f:
            CFG.update({k: v for k, v in json.load(_f).items() if k in CFG_DEFECTO and v is not None and (v != "" or k.endswith("_pass"))})
except Exception as _e:
    print(f"[!] No se pudo leer GF_CONFIG ({_e}); se usan los valores de fabrica.")
for _k, _v in CFG_DEFECTO.items():   # los numeros siguen siendo numeros aunque lleguen como texto
    if isinstance(_v, int):
        try:
            CFG[_k] = int(float(str(CFG[_k]).strip()))
        except Exception:
            CFG[_k] = _v

def lista_cfg(clave):
    """'a, b, c' -> ['a', 'b', 'c']"""
    return [x.strip() for x in str(CFG[clave]).replace(";", ",").split(",") if x.strip()]

EN_APP = os.environ.get("GF_APP") == "1"

def aviso(**datos):
    """Linea para la app: @@GF {json}. En terminal no estorba (se ve como una linea mas)."""
    try:
        sys.stdout.write("\n@@GF " + json.dumps(datos, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

def pedir(tipo, mensaje, segundos=None, defecto="", **extra):
    """Pide algo al operador. Con la app: aviso + respuesta por stdin. En terminal: input().
    Con 'segundos', si nadie contesta a tiempo regresa 'defecto'."""
    if EN_APP:
        aviso(pide=tipo, msg=mensaje, segundos=segundos, **extra)
        if segundos:
            listo, _, _ = select.select([sys.stdin], [], [], segundos)
            if not listo:
                aviso(pide_fin=tipo)
                print(f"[*] Nadie contesto en {segundos} s: se toma '{defecto}'.")
                return defecto
        r = sys.stdin.readline()
        if r == "":
            raise RuntimeError(f"La app no respondio a la pregunta '{tipo}'.")
        return r.rstrip("\r\n")
    if segundos:
        print(mensaje + f" (se toma '{defecto}' en {segundos} s)")
        listo, _, _ = select.select([sys.stdin], [], [], segundos)
        return sys.stdin.readline().rstrip("\r\n") if listo else defecto
    return input(mensaje + " ")

def usuario():
    """Usuario dueno del home donde se trabaja (antes se asumia 'testusr')."""
    u = os.environ.get("SUDO_USER")
    if u:
        return u
    try:
        return getpass.getuser()
    except Exception:
        return "testusr"

def home():
    if os.environ.get("SUDO_USER"):
        return os.path.expanduser(f"~{os.environ['SUDO_USER']}")
    return os.path.expanduser("~")

def en_home(nombre):
    """Rutas fijas en el home (antes dependian de la carpeta desde donde se corria)."""
    return nombre if os.path.isabs(nombre) else os.path.join(home(), nombre)

# ==============================================================================
# LOG (solo cuando se corren pasos)
# ==============================================================================
START_TIME = time.time()
LOG_FILE_PATH = en_home(f"engine_log_{time.strftime('%Y%m%d_%H%M%S')}.log")

class DualLogger:
    """Duplica la salida estandar (stdout) y de error (stderr) hacia la terminal y un archivo de log."""
    def __init__(self, filepath):
        self.terminal = sys.stdout
        self.logfile = open(filepath, "a", encoding="utf-8")

    def write(self, message):
        self.terminal.write(message)
        if self.logfile and not self.logfile.closed:
            self.logfile.write(message)
        self.flush()

    def flush(self):
        self.terminal.flush()
        if self.logfile and not self.logfile.closed:
            self.logfile.flush()

    def close(self):
        if self.logfile and not self.logfile.closed:
            self.logfile.flush()
            os.fsync(self.logfile.fileno())
            self.logfile.close()

logger_instance = None

def activar_log():
    global logger_instance
    if logger_instance is not None:
        return
    logger_instance = DualLogger(LOG_FILE_PATH)
    sys.stdout = logger_instance
    sys.stderr = logger_instance
    atexit.register(log_final_summary)

def log_final_summary():
    """Calcula el tiempo transcurrido y escribe el resumen final en el log antes de salir o reiniciar."""
    elapsed_seconds = int(time.time() - START_TIME)
    minutes, seconds = divmod(elapsed_seconds, 60)
    time_str = f"{minutes} min {seconds} s" if minutes > 0 else f"{seconds} s"
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(
        f"\n======================================================================\n"
        f" [LOG CLOSED] Fecha: {timestamp}\n"
        f" [LOG CLOSED] Tiempo total transcurrido: {time_str}\n"
        f"======================================================================\n"
    )
    if logger_instance is not None:
        logger_instance.close()

# ==============================================================================
# VARIABLES GLOBALES Y CONTRASENAS
# ==============================================================================
STATE_FILE = en_home(CFG["state_file"])
TROSS_STATE_FILE = en_home(CFG["tross_state_file"])

# Racks que ya venian avanzados con los nombres viejos: se copian una vez a los nuevos
# (los viejos se quedan como respaldo, no se borran)
for _nuevo, _viejo in ((STATE_FILE, en_home("provisioning_state.json")), (TROSS_STATE_FILE, en_home("tross_config.json"))):
    try:
        if not os.path.exists(_nuevo) and os.path.exists(_viejo):
            shutil.copyfile(_viejo, _nuevo)
            os.chmod(_nuevo, 0o600)
            sys.stderr.write(f"[*] Se copiaron las banderas de {os.path.basename(_viejo)} a {os.path.basename(_nuevo)}.\n")
    except Exception as _e:
        sys.stderr.write(f"[!] No se pudieron copiar las banderas viejas de {_viejo} ({_e}).\n")
SUDO_PASSWORD = os.environ.get("GF_SUDO_PASS", "")
VAULT_PASSWORD = os.environ.get("GF_VAULT_PASS", "")
MIRROR_PASSWORD = os.environ.get("GF_MIRROR_PASS", "")
DEFAULT_NOMACHINE_URL = CFG["nomachine_url"]
GPG_KEY_IMPORT_CMD = (
    f"wget -q -O - {CFG['chrome_key_url']} | "
    "sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/google-chrome.gpg"
)

_NOMBRES_PASS = {"sudo": ("GF_SUDO_PASS", "SUDO_PASSWORD"), "vault": ("GF_VAULT_PASS", "VAULT_PASSWORD"),
                 "mirror": ("GF_MIRROR_PASS", "MIRROR_PASSWORD")}

def requiere(*cuales):
    """Revisa que esten las contrasenas que necesita un paso. En terminal las pide; con la app, falla claro."""
    for c in cuales:
        env, var = _NOMBRES_PASS[c]
        if globals().get(var):
            continue
        if not EN_APP and sys.stdin.isatty():
            globals()[var] = getpass.getpass(f"Contrasena de {c}: ")
            continue
        raise RuntimeError(f"Falta la contrasena de {c} ({env}).")

_TXT_PASS = {"juniper_pass": "Contrasena de root que se le va a poner al Juniper",
             "zpe_pass": "Contrasena del usuario del ZPE",
             "tross_pass": "Contrasena de root del Tross"}

def pass_equipo(clave):
    """Contrasena de un equipo (Juniper / ZPE / Tross). Sale de Valores; si esta vacia se pregunta."""
    if CFG.get(clave):
        return CFG[clave]
    if EN_APP:
        r = pedir("password", _TXT_PASS[clave] + " (no esta en Valores):", clave=clave)
    else:
        r = getpass.getpass(_TXT_PASS[clave] + ": ")
    if not r:
        raise RuntimeError(f"Falta {_TXT_PASS[clave].lower()}. Ponla en Valores.")
    CFG[clave] = r
    return r

# --- sudo sin terminal: la contrasena va por stdin a 'sudo -S' ---
def _quitar_sudo(cmd):
    c = cmd.lstrip()
    return c[5:] if c.startswith("sudo ") else None

def sh_run(cmd, capture_output=True, timeout=None, check=False):
    """Como subprocess.run(cmd, shell=True) pero si empieza con 'sudo ' manda la contrasena
    por stdin (sin terminal, como corre la app, 'sudo' a secas no puede preguntar)."""
    sin = _quitar_sudo(cmd)
    kw = dict(text=True, timeout=timeout)
    if capture_output:
        kw.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if sin is not None and SUDO_PASSWORD:
        res = subprocess.run(["sudo", "-S", "-p", "", "bash", "-c", sin], input=SUDO_PASSWORD + "\n", **kw)
    else:
        res = subprocess.run(cmd, shell=True, **kw)
    if check and res.returncode != 0:
        raise RuntimeError(f"Error ejecutando: {cmd} (rc={res.returncode}) {(res.stderr or '').strip()[:300]}")
    return res

def sudo_lista(args, **kw):
    """subprocess.run(['sudo', ...]) con la contrasena por stdin."""
    if SUDO_PASSWORD:
        return subprocess.run(["sudo", "-S", "-p", ""] + list(args), input=SUDO_PASSWORD + "\n",
                              capture_output=True, text=True, **kw)
    return subprocess.run(["sudo"] + list(args), capture_output=True, text=True, **kw)

def sudo_simple(cmd, timeout=1800):
    """Corre 'cmd' con sudo SIN pexpect, mostrando la salida en vivo.
    Se usa antes de que este instalado pexpect en un servidor nuevo."""
    print(f"[CMD sudo] {cmd}")
    p = subprocess.Popen(["sudo", "-S", "-p", "", "bash", "-c", cmd], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    try:
        p.stdin.write((SUDO_PASSWORD or "") + "\n"); p.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    fin = time.time() + timeout
    for linea in p.stdout:
        sys.stdout.write(linea); sys.stdout.flush()
        if time.time() > fin:
            p.kill()
            raise RuntimeError(f"Timeout en comando: {cmd}")
    p.wait()
    if p.returncode != 0:
        raise RuntimeError(f"Error ejecutando: {cmd} (Exit code: {p.returncode})")
    return 0

def _cargar_pexpect():
    """Despues de instalar python3-pexpect con apt, lo carga sin reiniciar el script."""
    global pexpect
    if pexpect:
        return True
    import importlib
    importlib.invalidate_caches()
    for d in ("/usr/lib/python3/dist-packages", "/usr/local/lib/python3/dist-packages"):
        if os.path.isdir(d) and d not in sys.path:
            sys.path.append(d)
    try:
        pexpect = importlib.import_module("pexpect")
        return True
    except ImportError:
        return False

def _esperar_red(destinos=None, segundos=40):
    """Espera a que la red SFC responda (ping al gateway / mirror) antes de usar apt."""
    destinos = destinos or [CFG["gateway"], CFG["mirror_ip"]]
    fin = time.time() + segundos
    while time.time() < fin:
        for d in destinos:
            if subprocess.run(["ping", "-c", "1", "-W", "2", d], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                print(f"[✓] La red responde ({d}).")
                return True
        time.sleep(2)
    print(f"[AVISO] La red no respondio en {segundos} s ({', '.join(destinos)}). Se intenta seguir...")
    return False

def print_ascii_fail(message="Se detecto un error durante la ejecucion."):
    """Banner compacto de FALLO (rojo). 'message' describe que fallo
    especificamente -- esta funcion se usa desde muchos pasos distintos
    del script (no solo Ansible), asi que el mensaje debe ser generico
    por default y cada llamada puede pasar contexto especifico."""
    red = "\033[91m\033[1m"
    reset = "\033[0m"
    width = 66
    print(f"\n{red}┌{'─' * width}┐{reset}")
    print(f"{red}│{'✗  FALLO'.center(width)}│{reset}")
    print(f"{red}├{'─' * width}┤{reset}")
    for line in [message, "Revisa el log de arriba para mas detalle."]:
        print(f"{red}│ {line[:width-2].ljust(width-2)} │{reset}")
    print(f"{red}└{'─' * width}┘{reset}\n")

def print_ascii_pass(message="Mirror de apt + Ansible Playbook: OK."):
    """Banner compacto de EXITO (verde). Se usa tras confirmar que tanto
    el pre-flight de apt/mirror como el ansible-playbook terminaron sin
    tareas fallidas."""
    green = "\033[92m\033[1m"
    reset = "\033[0m"
    width = 66
    print(f"\n{green}┌{'─' * width}┐{reset}")
    print(f"{green}│{'✓  OK'.center(width)}│{reset}")
    print(f"{green}├{'─' * width}┤{reset}")
    print(f"{green}│ {message[:width-2].ljust(width-2)} │{reset}")
    print(f"{green}└{'─' * width}┘{reset}\n")

_state_perms_fixed = False

def fix_state_file_permissions():
    """Corrige el ownership de STATE_FILE una sola vez por ejecucion."""
    global _state_perms_fixed
    if _state_perms_fixed or os.geteuid() != 0:
        return   # corriendo como usuario normal el archivo ya es suyo
    if os.path.exists(STATE_FILE):
        sudo_user = usuario()
        subprocess.run(f"sudo chown {sudo_user}:{sudo_user} {STATE_FILE}", shell=True, stderr=subprocess.DEVNULL)
        _state_perms_fixed = True

def _atomic_write_json(filepath, data):
    """Escribe 'data' como JSON de forma atomica: primero a un archivo
    temporal, luego reemplaza el destino con os.replace() (atomico en
    POSIX), evitando dejar el archivo truncado si el proceso se interrumpe
    a mitad de la escritura. Deja ademas un respaldo '<filepath>.bak' del
    contenido previo."""
    if os.path.exists(filepath):
        try:
            shutil.copyfile(filepath, filepath + ".bak")
            os.chmod(filepath + ".bak", 0o600)
        except Exception as e:
            print(f"[!] Advertencia: no se pudo generar el respaldo de '{filepath}' ({e}).")
    tmp_path = f"{filepath}.tmp.{os.getpid()}"
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=4)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, filepath)

def _load_json_state(filepath):
    """Carga el JSON de 'filepath'. Si esta corrupto, intenta recuperarlo
    desde '<filepath>.bak'; si tampoco es posible, falla con un mensaje
    claro en vez de propagar el JSONDecodeError."""
    if not os.path.exists(filepath):
        return {"flags": {}, "config": {}}
    try:
        with open(filepath, "r") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        backup_path = filepath + ".bak"
        print(f"[!] Advertencia: '{filepath}' esta corrupto (JSON invalido: {e}).")
        if os.path.exists(backup_path):
            try:
                with open(backup_path, "r") as f:
                    data = json.load(f)
                print(f"[*] Se recupero el respaldo '{backup_path}' correctamente. "
                      f"Puede faltar el ultimo cambio que no llego a guardarse.")
                return data
            except json.JSONDecodeError:
                print(f"[!] El respaldo '{backup_path}' tambien esta corrupto.")
        raise RuntimeError(
            f"El archivo de estado '{filepath}' esta corrupto (JSON invalido) y no se "
            f"pudo recuperar desde su respaldo ('{backup_path}'). Revisalo/corregilo "
            f"manualmente, o borralo si preferis empezar de cero para este archivo, "
            f"antes de volver a correr el script."
        ) from e

def load_state():
    fix_state_file_permissions()
    return _load_json_state(STATE_FILE)

def save_state(state):
    fix_state_file_permissions()
    _atomic_write_json(STATE_FILE, state)

def is_step_completed(step_name):
    state = load_state()
    return state.get("flags", {}).get(step_name, False)

def mark_step_completed(step_name, extra_config=None):
    state = load_state()
    state.setdefault("flags", {})[step_name] = True
    if extra_config:
        state.setdefault("config", {}).update(extra_config)
    save_state(state)
    print(f"[✓] Paso '{step_name}' completado y registrado en {STATE_FILE}.")

# ==============================================================================
# ESTADO DEDICADO DE TROSS_CONFIG (engine_flags_tross.json)
# ==============================================================================
# Las banderas y config de las 13 etapas de TROSS_CONFIG viven en su propio
# archivo, separado de engine_flags.json: para rehacer el proceso del
# Tross desde cero alcanza con borrar engine_flags_tross.json, sin afectar el
# resto del estado del provisioning. 'tross_mac' sigue en el state file
# principal, ya que es un dato de entrada, no un progreso de este proceso.
_tross_state_perms_fixed = False

def fix_tross_state_file_permissions():
    """Analogo a fix_state_file_permissions() pero para TROSS_STATE_FILE."""
    global _tross_state_perms_fixed
    if _tross_state_perms_fixed or os.geteuid() != 0:
        return
    if os.path.exists(TROSS_STATE_FILE):
        sudo_user = usuario()
        subprocess.run(f"sudo chown {sudo_user}:{sudo_user} {TROSS_STATE_FILE}", shell=True,
                        stderr=subprocess.DEVNULL)
        _tross_state_perms_fixed = True

def load_tross_state():
    fix_tross_state_file_permissions()
    return _load_json_state(TROSS_STATE_FILE)

def save_tross_state(state):
    fix_tross_state_file_permissions()
    _atomic_write_json(TROSS_STATE_FILE, state)

def is_tross_step_completed(step_name):
    state = load_tross_state()
    return state.get("flags", {}).get(step_name, False)

def mark_tross_step_completed(step_name, extra_config=None):
    state = load_tross_state()
    state.setdefault("flags", {})[step_name] = True
    if extra_config:
        state.setdefault("config", {}).update(extra_config)
    save_tross_state(state)
    print(f"[✓] Paso '{step_name}' completado y registrado en {TROSS_STATE_FILE}.")
def _activate_sudo():
    """Activa (o refresca) sudo SIN poner la contrasena en la linea de comandos
    (antes iba en un 'echo', se veia en 'ps' y se rompia con comillas o $)."""
    if not SUDO_PASSWORD:
        return False
    try:
        res = subprocess.run(["sudo", "-S", "-p", "", "-v"], input=SUDO_PASSWORD + "\n",
                             capture_output=True, text=True, timeout=15)
        if res.returncode != 0:
            print(f"[!] Advertencia: no se pudo activar/refrescar sudo automaticamente "
                  f"({res.stderr.strip()}).")
        return res.returncode == 0
    except Exception as e:
        print(f"[!] Advertencia: excepcion al activar/refrescar sudo automaticamente ({e}).")
        return False

def run_command(cmd, check=True):
    print(f"[CMD] {cmd}")
    res = sh_run(cmd, capture_output=False) if _quitar_sudo(cmd) is not None else \
        subprocess.run(cmd, shell=True, stderr=subprocess.PIPE, text=True)
    if getattr(res, "stderr", None):
        sys.stderr.write(res.stderr)
    if check and res.returncode != 0:
        err_detail = res.stderr.strip() if getattr(res, "stderr", None) else "(sin salida en stderr)"
        raise RuntimeError(f"Error ejecutando comando: {cmd} (rc={res.returncode}). stderr: {err_detail}")
    return res.returncode

def run_capture(cmd):
    """Corre 'cmd' y regresa su salida como texto (para leer, no para cambiar nada)."""
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return res.stdout or ""

def run_interactive(cmd, timeout=3600):
    print(f"[CMD Interactive] {cmd}")
    child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=timeout)
    child.logfile_read = sys.stdout

    while True:
        idx = child.expect([
            r"\[sudo\] password for .*:?",
            r"[pP]assword:",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=600)

        if idx == 0 or idx == 1:
            child.sendline(SUDO_PASSWORD)
        elif idx == 2:
            break
        elif idx == 3:
            child.close()
            raise RuntimeError(f"Timeout en comando interactivo: {cmd}")

    child.close()
    if child.exitstatus != 0:
        raise RuntimeError(f"Error en comando interactivo: {cmd} (Exit code: {child.exitstatus})")
    return child.exitstatus
def _set_dhcp_host_mac(host_name, mac, expected_ip, conf_path="/etc/dhcp/dhcpd.conf"):
    """Actualiza unicamente la MAC de la entrada 'host <host_name> { ... }' en
    el dhcpd.conf, sin tocar el resto del archivo (indentacion, orden,
    fixed-address, comentarios ni otras lineas).

    Falla con un error claro si la entrada no existe, si hay mas de una, si
    el numero de lineas del archivo cambia o si, tras el cambio, la linea no
    contiene la MAC y la IP esperadas."""
    host_re = rf"host[[:space:]]+{host_name}[[:space:]]*\{{[[:space:]]*hardware[[:space:]]+ethernet"

    count_res = sudo_lista(
        ["grep", "-cE", host_re, conf_path]
    )
    matches = int(count_res.stdout.strip() or 0)
    if matches != 1:
        print_ascii_fail(f"Se esperaba 1 entrada 'host {host_name}' en {conf_path} y hay {matches}.")
        raise RuntimeError(
            f"{conf_path} tiene {matches} entradas 'host {host_name} {{ hardware ethernet ... }}' "
            f"(se esperaba exactamente 1). No se modifico el archivo."
        )

    lines_before = sudo_lista(
        ["wc", "-l", conf_path]
    ).stdout.split()[0]

    sed_cmd = (
        f"sudo sed -i -E 's/({host_re}[[:space:]]+)[^;]+;/\\1{mac};/' {conf_path}"
    )
    run_interactive(sed_cmd)

    lines_after = sudo_lista(
        ["wc", "-l", conf_path]
    ).stdout.split()[0]
    if lines_before != lines_after:
        print_ascii_fail(f"El numero de lineas de {conf_path} cambio ({lines_before} -> {lines_after}).")
        raise RuntimeError(f"{conf_path} cambio de {lines_before} a {lines_after} lineas tras actualizar la MAC.")

    check_res = sudo_lista(
        ["grep", "-E", host_re, conf_path]
    )
    host_line = check_res.stdout.strip()
    if mac.lower() not in host_line.lower() or expected_ip not in host_line:
        print_ascii_fail(f"La entrada 'host {host_name}' no quedo con la MAC/IP esperadas.")
        raise RuntimeError(
            f"Tras actualizar, la entrada de '{host_name}' es: '{host_line}' "
            f"(se esperaba MAC {mac} e IP {expected_ip})."
        )
    print(f"[✓] {host_line}")

def _retry_download(fn, description, max_retries=3, base_delay=10):
    """Reintenta con backoff exponencial una operacion de descarga/red
    (SCP, wget, etc.) que puede fallar de forma transitoria. 'fn' es un
    callable sin argumentos (usar lambda o functools.partial) que debe
    levantar una excepcion si la descarga fallo."""
    last_exc = None
    for attempt in range(1, max_retries + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            print(f"[!] Intento {attempt}/{max_retries} de '{description}' fallo: {e}")
            if attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                print(f"[*] Reintentando '{description}' en {delay}s...")
                time.sleep(delay)
    raise RuntimeError(f"'{description}' fallo tras {max_retries} intentos. Ultimo error: {last_exc}")
def set_ID():
    if is_step_completed("set_ID"):
        print("[=] Paso 'set_ID' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 1: Configuracion de ID de Rack ---")
    # El rack llega de la app (GF_RACK); si no, se pregunta
    rack_num_str = (os.environ.get("GF_RACK") or pedir("rack", "Ingresa el numero de rack (ej. 90 o 54):")).strip()

    if not rack_num_str.isdigit() or int(rack_num_str) < 1:
        raise ValueError("El numero de rack debe ser un numero mayor a 0.")

    rack_num = int(rack_num_str)
    last_octet = rack_num + CFG["suma_rack"]
    if last_octet > 254:
        raise ValueError(f"El octeto calculado ({last_octet}) excede el rango valido de IP.")

    ip_address = f"{CFG['red_base']}{last_octet}"
    hostname = f"{CFG['hostname_prefijo']}{rack_num:03d}"

    config_data = {
        "rack_number": rack_num,
        "ip_address": ip_address,
        "hostname": hostname
    }

    print(f"\n[+] Rack Numero: {rack_num}")
    print(f"[+] IP Calculada: {ip_address}")
    print(f"[+] Hostname Asignado: {hostname}\n")

    mark_step_completed("set_ID", config_data)

def set_network():
    if is_step_completed("set_network"):
        print("[=] Paso 'set_network' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 2: Configuracion de Red y Paquetes Base ---")
    state = load_state()
    ip_address = state.get("config", {}).get("ip_address")

    if not ip_address:
        raise RuntimeError("No se encontro la IP en la configuracion. Asegurate de correr 'set_ID' primero.")

    # Si ya existe una conexion "SFC" (corrida anterior) se recrea, para no duplicarla
    existe = subprocess.run(["nmcli", "-t", "-f", "NAME", "connection", "show"], capture_output=True, text=True)
    if "SFC" in (existe.stdout or "").splitlines():
        print("[=] Ya existe la conexion 'SFC'. Se recrea con la IP de este rack...")
        sudo_simple('nmcli con delete "SFC"')
    sudo_simple(
        f'nmcli con add con-name "SFC" ifname {CFG["iface_sfc"]} type ethernet '
        f'ipv4.method manual ipv4.addresses {ip_address}/24 gw4 {CFG["gateway"]} ipv4.dns {CFG["dns"]}'
    )
    sudo_simple('nmcli con up "SFC"')
    _esperar_red()

    # Ubuntu recien instalado corre actualizaciones en segundo plano y bloquea apt: que espere en vez de fallar
    sudo_simple("echo 'DPkg::Lock::Timeout \"600\";' > /etc/apt/apt.conf.d/99ghostfish-espera")

    # Lo que necesita el script y la app desde el inicio (en un servidor nuevo todavia no existe)
    print("[*] Instalando python3-pexpect y minicom...")
    sudo_simple("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pexpect minicom", timeout=1800)
    if not _cargar_pexpect():
        raise RuntimeError("Se instalo python3-pexpect pero Python no lo pudo cargar. Vuelve a correr este paso.")

    print("[*] Verificando e importando llaves GPG faltantes para apt...")
    _retry_download(lambda: run_interactive(GPG_KEY_IMPORT_CMD), "descarga de llave GPG de Google")

    apt_install([
        "openssh-server", "net-tools", "git", "sssd", "sssd-tools",
        "libpam-sss", "libnss-sss", "python3-pip",
    ])

    print("[*] Instalando dependencias iniciales de pip3...")
    run_interactive("sudo pip3 install colorlog jsonpickle google.cloud --upgrade")

    ssh_key_path = os.path.join(home(), ".ssh/id_rsa")
    if not os.path.exists(ssh_key_path):
        print("[*] Generando llaves SSH (ssh-keygen)...")
        os.makedirs(os.path.dirname(ssh_key_path), exist_ok=True)
        run_command(f"ssh-keygen -t rsa -N \"\" -f {ssh_key_path}")
        print("[✓] Llaves SSH generadas exitosamente.")
    else:
        print(f"[=] La llave SSH ya existe en {ssh_key_path}. Omitiendo ssh-keygen...")

    mark_step_completed("set_network")

def _run_scp_from_mirror_once(remote_path, local_destination):
    mirror_ip = CFG["mirror_ip"]
    cmd = f"scp {CFG['mirror_user']}@{mirror_ip}:{remote_path} {local_destination}"
    print(f"[CMD] Copiando desde Mirror: {cmd}")

    child = pexpect.spawn(cmd, encoding="utf-8", timeout=30)
    
    while True:
        idx = child.expect([
            r"Are you sure you want to continue connecting \(yes/no/\[fingerprint\]\)\?",
            r"[pP]assword:",
            pexpect.EOF,
            pexpect.TIMEOUT
        ])
        
        if idx == 0:
            child.sendline("yes")
        elif idx == 1:
            child.sendline(MIRROR_PASSWORD)
        elif idx == 2:
            break
        elif idx == 3:
            child.close()
            raise RuntimeError(f"Timeout copiando {remote_path} desde el Git Mirror.")

    child.close()
    if child.exitstatus != 0:
        raise RuntimeError(f"Error transfiriendo {remote_path} desde el Git Mirror.")

def run_scp_from_mirror(remote_path, local_destination):
    """Wrapper con reintentos (backoff exponencial) sobre la copia SCP real,
    para tolerar caidas transitorias de red hacia el Git-Mirror."""
    _retry_download(
        lambda: _run_scp_from_mirror_once(remote_path, local_destination),
        f"SCP de {remote_path} desde el Git-Mirror"
    )
def gitconfig_cookie():
    if is_step_completed("gitconfig_cookie"):
        print("[=] Paso 'gitconfig_cookie' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 3: Git Config & Security Repository Setup ---")
    state = load_state()
    ip_address = state.get("config", {}).get("ip_address")

    if not ip_address:
        raise RuntimeError("No se encontro la IP en la configuracion. Asegurate de correr 'set_ID' primero.")

    sudo_user = usuario()
    user_home = home()

    run_scp_from_mirror("~/.gitconfig", f"{user_home}/")
    run_scp_from_mirror("~/.gitcookies", f"{user_home}/")

    sec_repo_path = os.path.join(user_home, "security-hardened-image")
    if not os.path.exists(sec_repo_path):
        print("[*] Clonando repo security-hardened-image...")
        clone_cmd = f"git clone {CFG['repo_security']} {sec_repo_path}"
        run_command(clone_cmd)
    else:
        print("[=] El repositorio 'security-hardened-image' ya existe. Omitiendo clonacion...")

    run_scp_from_mirror("security-read-flg.json", f"{user_home}/")
    mark_step_completed("gitconfig_cookie")

def flex_tag():
    if is_step_completed("flex_tag"):
        print("[=] Paso 'flex_tag' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 4: Flex Tagging & Patch Script Setup ---")
    sudo_user = usuario()
    user_home = home()
    patch_script_path = os.path.join(user_home, "security-hardened-image/scripts/setup-patch.sh")

    if not os.path.exists(patch_script_path):
        raise FileNotFoundError(f"No se encontró el archivo: {patch_script_path}")

    with open(patch_script_path, "r") as f:
        content = f.read()

    content = re.sub(
        r"^export CROWDSTRIKE_TAGS=.*$",
        f"export CROWDSTRIKE_TAGS={CFG['crowdstrike_tag']}",
        content,
        flags=re.MULTILINE
    )

    content = re.sub(
        r"^\s*\./scripts/prepare-dvc\.sh",
        "#./scripts/prepare-dvc.sh",
        content,
        flags=re.MULTILINE
    )

    with open(patch_script_path, "w") as f:
        f.write(content)
    
    print("[✓] Modificaciones aplicadas a setup-patch.sh.")

    print("[*] Añadiendo llave GPG mediante apt-key...")
    apt_key_cmd = f"sudo apt-key adv --keyserver {CFG['apt_keyserver']} --recv-keys {CFG['apt_key_id']}"
    run_interactive(apt_key_cmd)

    mark_step_completed("flex_tag")

def run_security_patch():
    if is_step_completed("run_security_patch"):
        print("[=] Paso 'run_security_patch' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 5: Ejecución de setup-patch.sh ---")
    sudo_user = usuario()
    user_home = home()
    sec_dir = os.path.join(user_home, "security-hardened-image")
    patch_script = os.path.join(sec_dir, "scripts/setup-patch.sh")

    if not os.path.exists(patch_script):
        raise FileNotFoundError(f"No se encontró el script en: {patch_script}")

    run_command(f"chmod +x {patch_script}")
    run_interactive(f"sudo chown -R {sudo_user}:{sudo_user} {sec_dir}")

    cmd = f"cd {sec_dir} && ./scripts/setup-patch.sh"
    run_interactive(cmd, timeout=3600)

    mark_step_completed("run_security_patch")

def validate_and_lego_setup():
    if is_step_completed("validate_and_lego_setup"):
        print("[=] Paso 'validate_and_lego_setup' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 6: Validacion de Parches y Configuracion de Lego-Infra ---")
    sudo_user = usuario()
    user_home = home()
    sec_op_dir = os.path.join(user_home, "security-hardened-image/security_features_operation")

    print("[*] Ejecutando validacion de parches de seguridad...")
    val_cmd = f"cd {sec_op_dir} && python3 ./security_features_operator.py -c ansible.cfg -a validate"
    run_interactive(val_cmd, timeout=600)

    print("[*] Agregando repositorio universe e instala librerias pip de Google...")
    run_interactive("sudo add-apt-repository universe -y")
    run_interactive("sudo pip3 install google-cloud-appengine-logging google-cloud-audit-log google-cloud-logging")

    lego_dir = os.path.join(user_home, "lego-infra")
    if not os.path.exists(lego_dir):
        print("[*] Clonando repo lego-infra...")
        clone_cmd = f"git clone {CFG['repo_lego']} {lego_dir}"
        run_command(clone_cmd)
    else:
        print("[=] El repositorio 'lego-infra' ya existe. Omitiendo clonacion...")

    ansible_script_dir = os.path.join(lego_dir, "lego_setup/ansible_installation_script")
    print("[*] Ejecutando install-ansible-clean.sh...")
    ansible_cmd = f"cd {ansible_script_dir} && chmod +x install-ansible-clean.sh && ./install-ansible-clean.sh"
    run_interactive(ansible_cmd, timeout=1200)

    print("[*] Instalando librerias finales con pip3...")
    run_interactive("sudo pip3 install colorlog jsonpickle google.cloud")

    mark_step_completed("validate_and_lego_setup")

def setup_nomachine_yaml():
    if is_step_completed("setup_nomachine_yaml"):
        print("[=] Paso 'setup_nomachine_yaml' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 7: Actualizacion de URL NoMachine en YAML ---")
    sudo_user = usuario()
    yaml_path = f"{home()}/lego-infra/lego_setup/lego_abmx_test_server/install-nomachine.yaml"

    if not os.path.exists(yaml_path):
        raise FileNotFoundError(f"No se encontró el archivo: {yaml_path}")

    state = load_state()
    nomachine_url = DEFAULT_NOMACHINE_URL   # sale de Valores (antes se quedaba pegada la del estado)

    print(f"[+] Usando URL de NoMachine: {nomachine_url}")

    with open(yaml_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    updated = False
    pattern = r'deb:\s*["\']?\{\{\s*nomachine_deb\s*\}\}["\']?'

    target_idx = 98
    if target_idx < len(lines) and re.search(pattern, lines[target_idx]):
        lines[target_idx] = re.sub(pattern, f'deb: "{nomachine_url}"', lines[target_idx])
        updated = True
    else:
        for i, line in enumerate(lines):
            if re.search(pattern, line):
                lines[i] = re.sub(pattern, f'deb: "{nomachine_url}"', line)
                updated = True
                break

    if not updated:
        raise RuntimeError("No se encontro el patron 'deb: \"{{ nomachine_deb }}\"' en install-nomachine.yaml")

    with open(yaml_path, "w", encoding="utf-8") as f:
        f.writelines(lines)

    print(f"[✓] Archivo {yaml_path} actualizado exitosamente.")
    mark_step_completed("setup_nomachine_yaml", {"nomachine_url": nomachine_url})

# Mirrors candidatos a probar, en orden. El primero es el que ya usaba el
# sistema; el resto son mirrors publicos alternativos y confiables para
# Ubuntu 22.04 (jammy). Si tu org tiene un mirror interno/propio, ponlo
# primero en esta lista.
APT_CANDIDATE_MIRRORS = lista_cfg("apt_mirrors")

APT_SOURCES_FILE = "/etc/apt/sources.list"
APT_SOURCES_BACKUP = "/etc/apt/sources.list.bak-provisioning"


def _probe_mirror(mirror_url, connect_timeout=15):
    """HEAD request rapido para saber si el mirror responde antes de
    perder tiempo reescribiendo sources.list y corriendo apt."""
    probe = subprocess.run(
        f'curl -s -o /dev/null -w "%{{http_code}}" --max-time {connect_timeout} {mirror_url}',
        shell=True, capture_output=True, text=True
    )
    http_code = probe.stdout.strip()
    return probe.returncode == 0 and http_code.startswith(("2", "3")), http_code


def _backup_sources_list_once():
    if not os.path.exists(APT_SOURCES_BACKUP):
        sh_run(f"sudo cp {APT_SOURCES_FILE} {APT_SOURCES_BACKUP}")


def _restore_sources_list():
    if os.path.exists(APT_SOURCES_BACKUP):
        sh_run(f"sudo cp {APT_SOURCES_BACKUP} {APT_SOURCES_FILE}")


def _point_sources_list_to_mirror(mirror_url):
    """Reemplaza cualquier host de archive.ubuntu.com en sources.list por
    el mirror dado, para que cualquier llamada posterior a apt (incluida
    la de Ansible, que lee el mismo sources.list) use el mismo mirror que
    ya comprobamos que funciona."""
    sed_cmd = (
        r"sudo sed -i -E "
        r"'s#https?://[a-zA-Z0-9.-]+/ubuntu/#" + mirror_url.replace("/", r"\/") + r"#g' "
        + APT_SOURCES_FILE
    )
    sh_run(sed_cmd)


def _apt_with_mirror_fallback(apt_command, description, max_retries_per_mirror=2,
                               base_delay=10, connect_timeout=15):
    """Nucleo generico de 'ejecutar un comando de apt probando varios mirrors
    con reintentos'. Usado tanto por apt_update()/apt_install() (para
    cualquier paso del script que necesite instalar paquetes) como por
    ensure_apt_mirror_ready() (el pre-flight especifico del dist-upgrade
    antes de Ansible).

    Siempre corre 'apt-get update' primero contra el mirror que se este
    probando, y luego 'apt_command'. Si cualquiera de los dos falla, se
    reintenta (backoff exponencial) y, si se agotan los reintentos, se
    prueba el siguiente mirror de APT_CANDIDATE_MIRRORS.

    Devuelve el mirror_url que funciono. Lanza RuntimeError si todos los
    mirrors fallan (y en ese caso restaura el sources.list original).
    """
    _backup_sources_list_once()

    for mirror_url in APT_CANDIDATE_MIRRORS:
        print(f"[*] Probando mirror: {mirror_url}")
        reachable, http_code = _probe_mirror(mirror_url, connect_timeout)

        if not reachable:
            print(f"[!] Mirror no respondio (HTTP '{http_code}'). Probando el siguiente...")
            continue

        print(f"[✓] Mirror respondio HTTP {http_code}. Apuntando sources.list a este mirror...")
        _point_sources_list_to_mirror(mirror_url)

        for attempt in range(1, max_retries_per_mirror + 1):
            print(f"[*] apt-get update (mirror={mirror_url}, intento {attempt}/{max_retries_per_mirror})...")
            update_res = sh_run("sudo apt-get update")

            if update_res.returncode != 0:
                print(f"[!] 'apt-get update' fallo (rc={update_res.returncode}). "
                      f"stderr: {update_res.stderr.strip()[:300]}")
            else:
                print(f"[*] {description} (mirror={mirror_url}, intento {attempt}/{max_retries_per_mirror})...")
                cmd_res = sh_run(apt_command)
                if cmd_res.returncode == 0:
                    print(f"[✓] '{description}' completado correctamente con {mirror_url}.")
                    return mirror_url
                else:
                    print(f"[!] '{description}' fallo (rc={cmd_res.returncode}). "
                          f"stderr: {cmd_res.stderr.strip()[:500]}")

            if attempt < max_retries_per_mirror:
                delay = base_delay * (2 ** (attempt - 1))
                print(f"[*] Reintentando en {delay}s con el mismo mirror...")
                time.sleep(delay)

        print(f"[!] {mirror_url} agoto sus reintentos para '{description}'. Probando el siguiente mirror...")

    _restore_sources_list()
    raise RuntimeError(
        f"No se pudo completar '{description}' con ninguno de los mirrors probados "
        f"({', '.join(APT_CANDIDATE_MIRRORS)}). Se restauro el sources.list original. "
        f"Verifica la conectividad de red del host o agrega un mirror interno "
        f"confiable al inicio de APT_CANDIDATE_MIRRORS."
    )


def apt_update():
    """'apt-get update' con fallback automatico entre mirrors. Usar SIEMPRE
    en vez de 'run_interactive(\"sudo apt update\")' / 'sudo apt-get update'
    sueltos, para que un mirror caido no tumbe el paso completo."""
    return _apt_with_mirror_fallback("true", "apt-get update")


def apt_install(pkgs, update=True):
    """Instala uno o mas paquetes con fallback automatico entre mirrors y
    reintentos. 'pkgs' puede ser un string ('git curl') o una lista
    (['git', 'curl']). Usar SIEMPRE en vez de 'run_interactive(\"sudo apt
    install -y ...\")' suelto en cualquier paso del script.

    Con update=True (default) corre 'apt-get update' contra el mismo
    mirror antes de instalar, en la misma pasada (necesario, por ejemplo,
    justo despues de agregar un repo nuevo como el de Chrome).
    """
    pkgs_str = pkgs if isinstance(pkgs, str) else " ".join(pkgs)
    install_cmd = f"sudo DEBIAN_FRONTEND=noninteractive apt-get install -y {pkgs_str}"

    if update:
        return _apt_with_mirror_fallback(install_cmd, f"apt-get install -y {pkgs_str}")

    # Sin update explicito: solo probamos el mirror ya configurado (el que
    # haya quedado de una llamada previa a apt_update()/apt_install()) y
    # corremos el install directo, con reintentos simples.
    for attempt in range(1, 3):
        res = sh_run(install_cmd)
        if res.returncode == 0:
            print(f"[✓] apt-get install -y {pkgs_str} completado.")
            return True
        print(f"[!] Intento {attempt}/2 de 'apt-get install -y {pkgs_str}' fallo: "
              f"{res.stderr.strip()[:300]}")
        time.sleep(10)
    raise RuntimeError(f"No se pudo instalar {pkgs_str} tras 2 intentos (update=False).")


def ensure_apt_mirror_ready(max_retries_per_mirror=2, base_delay=10, connect_timeout=15):
    """Pre-flight ANTES de correr el playbook de Ansible.

    El playbook incluye una tarea de 'apt-get dist-upgrade' contra el
    mirror de Ubuntu configurado. Ese mirror a veces devuelve 403 Forbidden
    o corta la conexion (connection reset) de forma transitoria, lo cual
    tumba la tarea de Ansible (que solo tiene 1 intento) y con ella todo
    el Paso 8.

    Corre el dist-upgrade DE VERDAD, aqui, en Python, antes de invocar
    Ansible, probando mirrors alternos si el actual falla (ver
    _apt_with_mirror_fallback). Si tiene exito, el sistema queda ya
    actualizado y cuando Ansible llegue a su propia tarea de
    'apt-get dist-upgrade' no habra nada pendiente que descargar (o sera
    minimo), usando el mismo mirror ya validado.
    """
    _apt_with_mirror_fallback(
        "sudo DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y",
        "apt-get dist-upgrade -y",
        max_retries_per_mirror=max_retries_per_mirror,
        base_delay=base_delay,
        connect_timeout=connect_timeout,
    )
    return True

def ensure_dhcp():
    """Verifica que dhcpd.conf y dhcpd6.conf existan en /etc/dhcp/ y reinicia
    los servicios DHCP (IPv4 e IPv6). Corre antes de run_ansible_playbook()."""
    if is_step_completed("ensure_dhcp"):
        print("[=] Paso 'ensure_dhcp' ya fue ejecutado previamente. Omitiendo...")
        return
    print("--- PASO: Asegurar configuracion de DHCP ---")

    for conf_path in ("/etc/dhcp/dhcpd.conf", "/etc/dhcp/dhcpd6.conf"):
        if not os.path.isfile(conf_path):
            print_ascii_fail(f"No existe '{conf_path}'.")
            raise RuntimeError(f"No se encontro '{conf_path}'. Verifica la configuracion de DHCP.")
        print(f"[✓] {conf_path} presente.")

    _run_shell_sequence([
        "sudo systemctl restart isc-dhcp-server",
        "sudo systemctl restart isc-dhcp-server6",
    ])

    print("[✓] Archivos DHCP verificados y servicios reiniciados.")
    mark_step_completed("ensure_dhcp")

def run_ansible_playbook():
    if is_step_completed("run_ansible_playbook"):
        print("[=] Paso 'run_ansible_playbook' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 8: Ejecucion de Ansible Playbook ---")
    state = load_state()
    hostname = state.get("config", {}).get("hostname")

    if not hostname:
        raise RuntimeError("No se encontro el hostname en la configuracion. Asegurate de correr 'set_ID' primero.")

    print("[*] Pre-flight: verificando mirror de apt antes de invocar Ansible...")
    ensure_apt_mirror_ready()

    pip_upgrade_cmd = f'sudo {CFG["python_ansible"]} -m pip install --upgrade pip'
    downgrade_cmd = f'sudo {CFG["python_ansible"]} -m pip install "{CFG["setuptools_version"]}"'

    print("[*] Actualizando pip a la ultima version...")
    run_interactive(pip_upgrade_cmd)

    print("[*] Aplicando downgrade de setuptools PRE-Ansible...")
    run_interactive(downgrade_cmd)

    sudo_user = usuario()
    playbook_dir = f"{home()}/lego-infra/lego_setup/lego_abmx_test_server"

    cmd = (
        f"cd {playbook_dir} && "
        f"ansible-playbook -i localhost, lego_abmx_test_server_setup.yml -vv "
        f"--ask-become-pass --connection=local --vault-id @prompt --flush-cache"
    )

    print(f"[CMD Interactive] {cmd}")
    child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=None)
    
    output_buffer = ""

    class PexpectLogger:
        def write(self, text):
            nonlocal output_buffer
            sys.stdout.write(text)
            sys.stdout.flush()
            output_buffer += text

        def flush(self):
            sys.stdout.flush()

    child.logfile_read = PexpectLogger()

    while True:
        idx = child.expect([
            r"BECOME password:",
            r"Vault password \(default\):",
            r"Do you want to continue\?",
            r"Was lego bootstrap script",
            r"Enter Test Network Interface",
            r"Enter VPN Network Interface",
            r"Enter SFC Network Interface",
            r"Enter Tross Network Interface",
            r"Are the values correct\?",
            r"do you want to replace it\?",
            r"Enter computer name",
            r"Press Enter to exit and view the task timing summary",
            pexpect.EOF
        ], timeout=None)

        if idx == 0:
            child.sendline(SUDO_PASSWORD)
        elif idx == 1:
            child.sendline(VAULT_PASSWORD)
        elif idx in (2, 3):
            child.sendline("yes")
        elif idx == 4:
            child.sendline(CFG["iface_test"])
        elif idx in (5, 6, 7):
            child.sendline("none")
        elif idx in (8, 9):
            child.sendline("yes")
        elif idx == 10:
            print(f"\n[*] Enviando hostname configurado: {hostname}")
            child.sendline(hostname)
        elif idx == 11:
            print("\n[*] Detectado prompt de salida (task timing). Enviando ENTER...")
            child.sendline("")
        elif idx == 12:
            break

    child.close()

    print("[*] Reactivando sudo de forma automatica tras el comando de ansible...")
    _activate_sudo()

    failed_match = re.search(r"failed=(\d+)", output_buffer)
    if failed_match:
        failed_count = int(failed_match.group(1))
        if failed_count > 0:
            print_ascii_fail(f"Ansible reporto {failed_count} tarea(s) fallida(s) (failed > 0).")
            raise RuntimeError(f"Ansible Playbook finalizo con {failed_count} tarea(s) fallida(s).")

    if child.exitstatus != 0:
        print_ascii_fail("Error en ejecucion de ansible-playbook.")
        raise RuntimeError(f"Error en ejecucion de ansible-playbook (Exit code: {child.exitstatus})")

    print_ascii_pass()

    print("[*] Aplicando downgrade de setuptools POST-Ansible...")
    run_interactive(downgrade_cmd)
    
    mark_step_completed("run_ansible_playbook")
    print("[*] Esperando 15 segundos antes de finalizar el paso...")
    time.sleep(15)

def provisional_dhcp():
    """Descarga dhcpd.conf y dhcpd6.conf desde 172.24.125.136:/etc/dhcp/ al
    home del usuario, los mueve a /etc/dhcp/ y reinicia los servicios DHCP
    (IPv4 e IPv6)."""
    if is_step_completed("provisional_dhcp"):
        print("[=] Paso 'provisional_dhcp' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 9: Configuracion de Archivos DHCP ---")

    sudo_user = usuario()
    home_dir = home()

    _scp_download(CFG["dhcp_user"], CFG["dhcp_host"], "/etc/dhcp/dhcpd.conf", home_dir)
    _scp_download(CFG["dhcp_user"], CFG["dhcp_host"], "/etc/dhcp/dhcpd6.conf", home_dir)

    _run_shell_sequence([
        f"sudo mv {home_dir}/dhcpd.conf /etc/dhcp/",
        f"sudo mv {home_dir}/dhcpd6.conf /etc/dhcp/",
        "sudo systemctl restart isc-dhcp-server",
        "sudo systemctl restart isc-dhcp-server6",
    ])

    print("[✓] Archivos DHCP instalados en /etc/dhcp/ y servicios reiniciados.")
    print("[*] Esperando 15 segundos...")
    time.sleep(15)

    mark_step_completed("provisional_dhcp")

def reinstall_goss():
    """Limpia binarios/archivos previos de Goss y lo reinstala de forma
    automatizada via el script oficial de goss.rocks. Es un paso independiente
    del testplan (con su propio estado en el JSON) que corre justo antes de
    run_final_abmx_config()."""
    if is_step_completed("reinstall_goss"):
        print("[=] Paso 'reinstall_goss' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 9.5: Limpieza y Reinstalacion de Goss ---")

    print("[*] Limpiando archivos goss anteriores...")
    run_command(f"rm -f {home()}/goss*", check=False)

    print("[*] Instalando Goss de forma automatizada...")
    goss_install_cmd = f"curl -fsSL {CFG['goss_url']} | sudo sh"
    run_interactive(goss_install_cmd)

    print("[✓] Goss reinstalado exitosamente.")
    mark_step_completed("reinstall_goss")
def run_final_abmx_config():
    if is_step_completed("run_final_abmx_config"):
        print("[=] Paso 'run_final_abmx_config' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 10: Run Final ABMX Server Configuration via Git-Mirror ---")
    state = load_state()
    ip_address = state.get("config", {}).get("ip_address")

    if not ip_address:
        raise RuntimeError("No se encontro la IP en la configuracion. Asegurate de correr 'set_ID' primero.")

    sudo_user = usuario()

    print("[*] Corrigiendo ownership de /home/testusr/.local...")
    fix_local_dir_cmd = f"sudo chown -R {sudo_user}:{sudo_user} {home()}/.local"
    run_interactive(fix_local_dir_cmd)

    mirror_ip = CFG["mirror_ip"]

    ssh_copy_cmd = f"ssh-copy-id -i ~/.ssh/id_rsa.pub {sudo_user}@{ip_address}"
    cmd_remote_copy = f"ssh {sudo_user}@{mirror_ip} '{ssh_copy_cmd}'"
    print(f"[CMD Interactive] {cmd_remote_copy}")

    child_copy = pexpect.spawn("bash", ["-c", cmd_remote_copy], encoding="utf-8", timeout=300)
    child_copy.logfile_read = sys.stdout

    while True:
        idx = child_copy.expect([
            r"Are you sure you want to continue connecting \(yes/no/\[fingerprint\]\)\?",
            re.escape(f"{CFG['mirror_user']}@{mirror_ip}") + r"'s password:",
            r"[pP]assword:",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=120)

        if idx == 0:
            child_copy.sendline("yes")
        elif idx == 1:
            child_copy.sendline(MIRROR_PASSWORD)
        elif idx == 2:
            child_copy.sendline(SUDO_PASSWORD)   # ssh-copy-id hacia este servidor: contrasena del usuario local
        elif idx == 3:
            break
        elif idx == 4:
            child_copy.close()
            raise RuntimeError("Timeout intentando ssh-copy-id desde el Git-Mirror.")

    child_copy.close()

    ansible_cmd = (
        f"cd ~/amp-ansible && ansible-playbook -i {ip_address}, repo_updater/configure-fish-station.yaml "
        f"-vv --ask-become-pass --ask-pass --flush-cache --vault-id @prompt"
    )
    cmd_remote_ansible = f"ssh -t {sudo_user}@{mirror_ip} '{ansible_cmd}'"
    print(f"[CMD Interactive] {cmd_remote_ansible}")

    child_ansible = pexpect.spawn("bash", ["-c", cmd_remote_ansible], encoding="utf-8", timeout=None)
    child_ansible.logfile_read = sys.stdout

    play_recap_detected = False

    while True:
        idx = child_ansible.expect([
            r"Are you sure you want to continue connecting \(yes/no/\[fingerprint\]\)\?",
            re.escape(f"{CFG['mirror_user']}@{mirror_ip}") + r"'s password:",
            r"SSH password:",
            r"BECOME password\[defaults to SSH password\]:",
            r"BECOME password:",
            r"Vault password \(default\):",
            r"Please enter the password for '[^']+' \(operator\)",
            r"\[sudo\] password for [^:]+:",
            r"PLAY RECAP",
            pexpect.EOF
        ], timeout=None)

        if idx == 0:
            child_ansible.sendline("yes")
        elif idx == 1:
            child_ansible.sendline(MIRROR_PASSWORD)
        elif idx in (2, 3, 4, 6, 7):
            child_ansible.sendline(SUDO_PASSWORD)
        elif idx == 5:
            child_ansible.sendline(VAULT_PASSWORD)
        elif idx == 8:
            play_recap_detected = True
            child_ansible.sendline("exit")
        elif idx == 9:
            break

    child_ansible.close()

    print("[*] Reactivando sudo de forma automatica tras salir del mirror...")
    _activate_sudo()

    if not play_recap_detected or child_ansible.exitstatus != 0:
        print_ascii_fail()
        raise RuntimeError(f"Error en ejecucion de ansible-playbook via git-mirror (Exit code: {child_ansible.exitstatus})")

    mark_step_completed("run_final_abmx_config")
    print("[*] Esperando 15 segundos antes de finalizar el paso...")
    time.sleep(15)

def create_networkmanager_symlink():
    if is_step_completed("create_networkmanager_symlink"):
        print("[=] Paso 'create_networkmanager_symlink' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 11: Create NetworkManager Symlink & Install Required Packages ---")
    target_dir = "/usr/lib/systemd/system"

    print(f"[*] Listando archivos *etwork* en {target_dir}:")
    run_command(f"ls -l {target_dir}/*etwork*", check=False)

    print("[*] Actualizando lista de paquetes e instalando libsss-sudo y gnome-control-center...")
    apt_install(["libsss-sudo", "gnome-control-center"])

    print("[*] Creando symlink para network-manager.service...")
    symlink_cmd = f"sudo ln -sf {target_dir}/NetworkManager.service {target_dir}/network-manager.service"
    run_interactive(symlink_cmd)

    print("[*] Recargando daemon de systemd...")
    run_interactive("sudo systemctl daemon-reload")

    mark_step_completed("create_networkmanager_symlink")

def network_plan():
    if is_step_completed("network_plan"):
        print("[=] Paso 'network_plan' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 12: Configure Netplan for ens4f0 & ens4f1 ---")

    mac_f0 = None
    mac_f1 = None
    t0, t1 = CFG["iface_test"], CFG["iface_test2"]

    try:
        path_f0 = f'/sys/class/net/{t0}/address'
        path_f1 = f'/sys/class/net/{t1}/address'
        
        if os.path.exists(path_f0):
            with open(path_f0, 'r') as f:
                mac_f0 = f.read().strip().lower()
        if os.path.exists(path_f1):
            with open(path_f1, 'r') as f:
                mac_f1 = f.read().strip().lower()
    except Exception as e:
        print(f"[!] Warning leyendo sysfs: {e}")

    if not mac_f0 or not mac_f1:
        ifconfig_str = run_capture("ip -o link show; ifconfig -a 2>/dev/null")

        def _mac_de(nombre):
            m = re.search(re.escape(nombre) + r'(?:np\d)?:.*?(?:link/ether|\bether)\s+([0-9a-fA-F:]{17})', ifconfig_str, re.DOTALL)
            return m.group(1).lower() if m else None
        mac_f0 = mac_f0 or _mac_de(t0)
        mac_f1 = mac_f1 or _mac_de(t1)

    if not mac_f0 or not mac_f1:
        print_ascii_fail()
        raise RuntimeError(f"No se pudieron obtener las direcciones MAC ({t0}: {mac_f0}, {t1}: {mac_f1})")

    print(f"[+] MAC {t0}: {mac_f0}")
    print(f"[+] MAC {t1}: {mac_f1}")

    state = load_state()
    if "interfaces" not in state:
        state["interfaces"] = {}

    state["interfaces"][t0] = mac_f0
    state["interfaces"][t1] = mac_f1
    save_state(state)

    netplan_content = f"""# Let NetworkManager manage all devices on this system
network:
  version: 2
  ethernets:
      {t0}np0:
               dhcp4: no
               match:
                   macaddress: {mac_f0}
               set-name: {t0}
      {t1}np1:
               dhcp4: no
               match:
                   macaddress: {mac_f1}
               set-name: {t1}
  renderer: NetworkManager
"""

    netplan_path = "/etc/netplan/01-network-manager-all.yaml"
    temp_netplan = f"/tmp/01-network-manager-all.{os.getpid()}.yaml"

    print(f"[*] Actualizando {netplan_path}...")
    with open(temp_netplan, "w") as f:
        f.write(netplan_content)

    run_interactive(f"sudo mv {temp_netplan} {netplan_path}")
    run_interactive(f"sudo chmod 600 {netplan_path}")

    print("[*] Aplicando Netplan...")
    run_interactive("sudo netplan generate")
    run_interactive("sudo netplan apply")

    mark_step_completed("network_plan")

def force_test_network_selection():
    """Fuerza que la conexion 'Test Network' quede activa y priorizada en la interfaz ens4f0.

    A diferencia del resto de los pasos del script, este NO se omite aunque ya
    se haya ejecutado en una corrida anterior: cada vez que se abre
    gf_provisioning.py (posterior al run final de ABMX) hay que verificar que
    'Test Network' siga seleccionada, y volver a seleccionarla si no lo esta.
    Por eso no hay 'if is_step_completed(...): return' aqui; mark_step_completed()
    se sigue llamando al final solo para fines de registro/reporte."""

    print("--- PASO: Forzar seleccion de 'Test Network' en Ethernet (ens4f0) ---")

    interface = CFG["iface_test"]
    target_conn = CFG["test_network"]

    print(f"[*] Consultando perfiles de NetworkManager asociados a {interface}...")
    result = subprocess.run(
        ["nmcli", "-t", "-f", "NAME,DEVICE,UUID", "connection", "show"],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        print_ascii_fail()
        raise RuntimeError(f"No se pudo consultar las conexiones de NetworkManager: {result.stderr.strip()}")

    profiles_on_iface = []
    for line in result.stdout.strip().splitlines():
        parts = line.split(":")
        if len(parts) < 3:
            continue
        name, device = parts[0], parts[1]
        if device == interface:
            profiles_on_iface.append(name)

    print(f"[+] Perfiles detectados en {interface}: {profiles_on_iface or 'ninguno activo actualmente'}")

    all_names = subprocess.run(
        ["nmcli", "-t", "-f", "NAME", "connection", "show"],
        capture_output=True, text=True
    ).stdout.splitlines()

    if target_conn not in all_names:
        print_ascii_fail()
        raise RuntimeError(
            f"El perfil '{target_conn}' no existe en NetworkManager. "
            f"Debe crearse antes de poder forzar su seleccion."
        )

    print(f"[*] Activando el perfil '{target_conn}' en {interface}...")
    run_interactive(f'sudo nmcli connection up id "{target_conn}" ifname {interface}')

    print(f"[*] Asignando autoconexion y prioridad alta a '{target_conn}'...")
    run_interactive(
        f'sudo nmcli connection modify "{target_conn}" '
        f'connection.autoconnect yes connection.autoconnect-priority 100'
    )

    print(f"[*] Despriorizando otros perfiles detectados en {interface}...")
    for name in profiles_on_iface:
        if name == target_conn:
            continue
        print(f"    [-] Despriorizando perfil '{name}'...")
        run_interactive(f'sudo nmcli connection modify "{name}" connection.autoconnect-priority -100')

    print(f"[*] Verificando que '{target_conn}' quedo como conexion activa en {interface}...")
    verify = subprocess.run(
        ["nmcli", "-t", "-f", "GENERAL.CONNECTION", "device", "show", interface],
        capture_output=True, text=True
    )
    active_conn = verify.stdout.strip().split(":", 1)[-1].strip() if verify.stdout else ""

    if active_conn != target_conn:
        print_ascii_fail()
        raise RuntimeError(
            f"La conexion activa en {interface} es '{active_conn}', se esperaba '{target_conn}'."
        )

    print(f"[✓] '{target_conn}' quedo forzada como conexion activa en {interface}.")
    mark_step_completed("force_test_network_selection")
def _print_yellow_banner(message):
    """Imprime un mensaje resaltado en amarillo, con borde, para instrucciones manuales."""
    YELLOW = "\033[93m\033[1m"
    RESET = "\033[0m"
    border = "=" * 80
    print(f"\n{YELLOW}{border}")
    print(f"[!] {message}")
    print(f"{border}{RESET}\n")

def _print_green_banner(message):
    """Imprime un mensaje resaltado en verde, con borde, para confirmar exito o estado."""
    GREEN = "\033[92m\033[1m"
    RESET = "\033[0m"
    border = "=" * 80
    print(f"\n{GREEN}{border}")
    print(f"[✓] {message}")
    print(f"{border}{RESET}\n")

def _try_minicom_connect(device, baud):
    """Intenta abrir una sesion minicom sobre 'device' a la velocidad 'baud'.
    Devuelve el objeto pexpect.spawn conectado si tuvo exito, o None si fallo."""
    cmd = f"sudo minicom -D {device} -b {baud}"
    print(f"[CMD Interactive] {cmd}")
    c = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=30)
    c.logfile_read = sys.stdout

    idx = c.expect([
        r"\[sudo\] password for .*:?",
        r"[pP]assword:",
        r"Cannot open|No such file or directory|Device or resource busy|does not exist",
        r"Welcome to minicom|Press CTRL-A Z for help",
        pexpect.EOF,
        pexpect.TIMEOUT
    ], timeout=20)

    if idx in (0, 1):
        c.sendline(SUDO_PASSWORD)
        idx2 = c.expect([
            r"Cannot open|No such file or directory|Device or resource busy|does not exist",
            r"Welcome to minicom|Press CTRL-A Z for help",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=20)
        if idx2 == 1:
            return c
        c.close(force=True)
        return None
    elif idx == 3:
        return c
    else:
        c.close(force=True)
        return None

def _wait_for_console_connection(banner_message, devices, baud):
    """Cicla mostrando 'banner_message' en amarillo hasta detectar el cable de
    consola conectado (dispositivo serial presente) y establecer una sesion
    minicom valida sobre alguno de los 'devices'. No retorna hasta lograrlo."""
    while True:
        available = [d for d in devices if os.path.exists(d)]

        if not available:
            _print_yellow_banner(banner_message)
            print("[*] Cable de consola no detectado aun. Reintentando en 3 segundos...")
            time.sleep(3)
            continue

        for device in available:
            child = _try_minicom_connect(device, baud)
            if child:
                print(f"[✓] Conexion via minicom establecida en {device}")
                return child, device

        print("[!] Se detecto el dispositivo pero no se pudo abrir minicom. Reintentando en 3 segundos...")
        time.sleep(3)

def _wait_for_console_connection_enter(banner_message, devices, baud, tipo="cable"):
    """Igual que '_wait_for_console_connection', pero en vez de sondear solo,
    exige que el usuario presione ENTER antes de cada intento de deteccion.
    Muestra 'banner_message', espera ENTER y valida el cable de consola; si
    no se detecta (o no se logra abrir minicom), vuelve a mostrar el banner
    y a esperar ENTER, repitiendo hasta lograr una conexion valida."""
    while True:
        _print_yellow_banner(banner_message)
        pedir(tipo, banner_message + " Presiona ENTER (Listo) cuando este conectado.")

        available = [d for d in devices if os.path.exists(d)]

        if not available:
            print("[!] Cable de consola no detectado. Verifique la conexion e intente nuevamente.")
            continue

        for device in available:
            child = _try_minicom_connect(device, baud)
            if child:
                print(f"[✓] Conexion via minicom establecida en {device}")
                return child, device

        print("[!] Se detecto el dispositivo pero no se pudo abrir minicom. Intente nuevamente.")

def _minicom_exit(child):
    """Sale de una sesion minicom con Ctrl+A, X, confirmando el dialogo
    'Leave Minicom?' con ENTER (la opcion 'Yes' viene resaltada por defecto).
    Es seguro llamarla mas de una vez sobre el mismo 'child': si la sesion
    ya esta cerrada, no hace nada (evita el error 'Bad file descriptor')."""
    if child is None or getattr(child, "closed", False):
        return
    print("[*] Saliendo de minicom (Ctrl+A, X)...")
    try:
        child.send(chr(1))  # Ctrl+A
        time.sleep(0.5)
        child.send("x")
        idx = child.expect(
            [r"Leave Minicom\?", pexpect.TIMEOUT, pexpect.EOF],
            timeout=15
        )
        if idx == 0:
            child.sendline("")  # "Yes" viene resaltado por defecto, Enter confirma
    except Exception as e:
        print(f"[!] Advertencia: no se pudo confirmar la salida limpia de minicom ({e}).")
    finally:
        try:
            child.close(force=True)
        except Exception:
            pass
        # Cada vez que salimos de una consola minicom (ZPE, Juniper) se limpia
        # la terminal, para no dejar mezclado el output de la sesion serial
        # con lo que sigue imprimiendo el script.
        if not EN_APP:
            os.system("clear")

def _juniper_expect_or_fail(child, patterns, timeout, error_msg):
    """Helper para juniper_config(): hace expect() sobre 'patterns' y agrega
    pexpect.TIMEOUT y pexpect.EOF automaticamente como ultimas opciones.
    Si cae en TIMEOUT/EOF, imprime el banner de fallo y lanza RuntimeError.
    NO cierra minicom aqui: el 'finally' de juniper_config() se encarga de
    eso una sola vez, para evitar cierres duplicados sobre el mismo child."""
    full_patterns = list(patterns) + [pexpect.TIMEOUT, pexpect.EOF]
    idx = child.expect(full_patterns, timeout=timeout)
    if idx >= len(patterns):
        print_ascii_fail()
        raise RuntimeError(error_msg)
    return idx
def _juniper_salida(child, comando, prompt=r">\s", timeout=30):
    """Manda un comando al CLI y regresa lo que imprimió (sin el eco del comando)."""
    child.sendline(comando)
    idx = child.expect([prompt, pexpect.TIMEOUT, pexpect.EOF], timeout=timeout)
    texto = (child.before or "")
    if idx != 0:
        print_ascii_fail()
        raise RuntimeError(f"El Juniper no respondió a '{comando}'.")
    return texto.split(comando, 1)[-1] if comando in texto else texto

def _juniper_commit(child, que):
    """commit y revisa el resultado; si falla, regresa el mensaje real de JUNOS."""
    print(f"[*] Ejecutando commit ({que})...")
    child.sendline("commit")
    idx = child.expect([r"commit complete", r"error:|failed|configuration check-out failed", pexpect.TIMEOUT, pexpect.EOF], timeout=90)
    if idx == 0:
        child.expect([r"#\s", pexpect.TIMEOUT], timeout=20)
        return
    detalle = ((child.before or "") + (child.after if isinstance(child.after, str) else "")).strip().splitlines()[-6:]
    print_ascii_fail()
    raise RuntimeError(f"El commit de {que} falló: " + " | ".join(l.strip() for l in detalle if l.strip()))

def juniper_config():
    if is_step_completed("juniper_config"):
        print("[=] Paso 'juniper_config' ya fue ejecutado previamente. Omitiendo...")
        return

    requiere("sudo")
    root_pass = pass_equipo("juniper_pass")
    print("--- PASO: Configuracion Automatica del Juniper via Consola Serial ---")

    mensaje = (
        "Conecte cable consola al puerto CON del Juniper (Por la parte de atras) "
        "y el otro extremo a un puerto USB 3.0 del Superlogics/ABMX."
    )

    # --- PASO A: Confirmar el cable de consola y abrir minicom ---
    child, used_device = _wait_for_console_connection_enter(mensaje, lista_cfg("consolas"), CFG["juniper_baud"], "cable_juniper")
    child.logfile_read = sys.stdout
    version_esperada = CFG["juniper_version"]

    try:
        # --- PASO B: Login (o sesión ya abierta) ---
        print("[*] Buscando prompt del Juniper...")
        child.sendline("")
        idx = _juniper_expect_or_fail(
            child,
            [r"login:", r"root@[^\s]*:[^\s]*%\s|%\s$", r"root@[^\s]*>\s|>\s$", r"root@[^\s]*#\s|#\s$"],
            timeout=30,
            error_msg="No se detecto ningun prompt del Juniper tras conectar por consola (¿termino de arrancar?)."
        )
        if idx == 0:
            print("[*] Prompt 'login:' detectado. Ingresando usuario 'root'...")
            child.sendline("root")
            idx_auth = _juniper_expect_or_fail(
                child, [r"Password:", r"%\s"], timeout=30,
                error_msg="Tras ingresar 'root' no aparecio ni 'Password:' ni el prompt de shell."
            )
            if idx_auth == 0:
                # Ya tiene contraseña de root: se dejó configurado antes
                print("[=] El Juniper pidio 'Password:': ya tiene contrasena de root, se considera configurado.")
                _minicom_exit(child)
                _print_green_banner("EL JUNIPER YA ESTABA CONFIGURADO. Se omite la configuracion automatica.")
                mark_step_completed("juniper_config", {"juniper_console_device": used_device, "juniper_already_configured": True})
                return
            child.sendline("cli")
            _juniper_expect_or_fail(child, [r">\s"], timeout=30, error_msg="No se detecto el prompt operacional ('>') tras ejecutar 'cli'.")
        elif idx == 1:
            print("[=] La sesion ya estaba abierta en el shell. Entrando al CLI...")
            child.sendline("cli")
            _juniper_expect_or_fail(child, [r">\s"], timeout=30, error_msg="No se detecto el prompt operacional ('>') tras ejecutar 'cli'.")
        elif idx == 3:
            print("[=] La sesion estaba en modo configuracion. Saliendo al modo operacional...")
            child.sendline("exit configuration-mode")
            _juniper_expect_or_fail(child, [r">\s"], timeout=30, error_msg="No se pudo salir del modo configuracion.")
        else:
            print("[=] La sesion ya estaba en el CLI.")
        child.sendline("set cli screen-length 0")
        child.expect([r">\s", pexpect.TIMEOUT], timeout=10)

        # --- PASO C: Version de JUNOS con 'show version' (antes esperaba el letrero del login) ---
        print("[*] Validando version de JUNOS con 'show version'...")
        ver = _juniper_salida(child, "show version", timeout=40)
        m = re.search(r"Junos:\s*(\S+)|JUNOS[^\[]*\[([^\]]+)\]|JUNOS\s+(\d+\.\d+R\d+(?:\.\d+)?)", ver)
        version = next((g for g in (m.groups() if m else ()) if g), None)
        print(f"[+] Version detectada: {version or 'no reconocida'} · esperada: {version_esperada}")
        if not version or version_esperada not in version:
            RED = "\033[91m\033[1m"; RESET = "\033[0m"
            print(f"\n{RED}Version JUNIPER Incorrecta!!! Realizar Downgrade de Juniper...{RESET}\n")
            pedir("downgrade", "Version de JUNOS incorrecta (" + str(version) + "). Haz el downgrade manual y vuelve a correr este paso. Presiona ENTER.",
                  version=version, esperada=version_esperada)
            print_ascii_fail()
            raise RuntimeError(f"Version de JUNOS incorrecta: {version} (se esperaba {version_esperada}). Haz el downgrade.")
        print("[✓] Version de JUNOS validada correctamente.")

        # --- PASO D: Modo configuracion ---
        child.sendline("configure")
        _juniper_expect_or_fail(child, [r"#\s"], timeout=30, error_msg="No se detecto el prompt de configuracion ('#') tras 'configure'.")

        # --- PASO E: Contraseña de root ---
        print("[*] Configurando root-authentication plain-text-password...")
        child.sendline("set system root-authentication plain-text-password")
        _juniper_expect_or_fail(child, [r"[Nn]ew password:"], timeout=20, error_msg="No se recibio el prompt 'New password:' de JUNOS.")
        child.sendline(root_pass)
        _juniper_expect_or_fail(child, [r"[Rr]etype new password:"], timeout=20, error_msg="No se recibio el prompt 'Retype new password:' de JUNOS.")
        child.sendline(root_pass)
        idx = child.expect([r"#\s", r"error:.*", pexpect.TIMEOUT], timeout=20)
        if idx != 0:
            print_ascii_fail()
            raise RuntimeError("JUNOS no acepto la contrasena de root (muy corta o muy simple). Usa una mas larga.")
        _juniper_commit(child, "root-authentication")

        # --- PASO F: Quitar auto-image-upgrade ---
        print("[*] Eliminando chassis auto-image-upgrade...")
        child.sendline("delete chassis auto-image-upgrade")
        _juniper_expect_or_fail(child, [r"#\s"], timeout=20, error_msg="No se regreso al prompt tras 'delete chassis auto-image-upgrade'.")
        _juniper_commit(child, "delete chassis auto-image-upgrade")

        # --- PASO G: Interfaces como switch ---
        wildcard_commands = [
            "wildcard range delete interfaces et-0/0/[0-31] unit 0 family inet",
            "wildcard range delete interfaces et-0/0/[0-31]:[0-3] unit 0 family inet",
            "wildcard range delete interfaces xe-0/0/[0-31]:[0-3] unit 0 family inet",
            "wildcard range delete interfaces et-0/0/[0-31] unit 0",
            "wildcard range delete interfaces et-0/0/[0-31]:[0-3] unit 0",
            "wildcard range delete interfaces xe-0/0/[0-31]:[0-3] unit 0",
            "wildcard range set interfaces et-0/0/[0-31] unit 0 family ethernet-switching",
            "wildcard range set interfaces xe-0/0/[0-31]:[0-3] unit 0 family ethernet-switching",
        ]
        print("[*] Ejecutando comandos 'wildcard range' sobre las interfaces...")
        for wc_cmd in wildcard_commands:
            child.sendline(wc_cmd)
            _juniper_expect_or_fail(child, [r"#\s"], timeout=30, error_msg=f"No se regreso al prompt de configuracion tras: '{wc_cmd}'.")
        _juniper_commit(child, "interfaces")

        # --- PASO H: Salir, revisar alarmas y guardar rescate ---
        child.sendline("exit")
        _juniper_expect_or_fail(child, [r">\s"], timeout=20, error_msg="No se regreso al modo operacional ('>') tras 'exit'.")

        alarmas = _juniper_salida(child, "show system alarms")
        if re.search(r"No alarms currently active", alarmas, re.I):
            print("[✓] Sin alarmas activas.")
        else:
            lineas = [l.strip() for l in alarmas.splitlines() if l.strip() and not re.match(r"^\S*[>#%]\s*$", l.strip())][:6]
            print("[AVISO] El Juniper tiene alarmas activas: " + " | ".join(lineas))

        print("[*] Guardando configuracion de rescate (rescue save)...")
        rescate = _juniper_salida(child, "request system configuration rescue save", timeout=60)
        if re.search(r"error|failed|not saved", rescate, re.I):
            print_ascii_fail()
            raise RuntimeError("No se pudo guardar la configuracion de rescate: " + rescate.strip()[:200])
        print("[✓] Configuracion de rescate guardada.")

        # --- PASO I: Reiniciar el Juniper ---
        print("[*] Saliendo del CLI de JUNOS...")
        child.sendline("exit")
        _juniper_expect_or_fail(child, [r"%\s", r"login:"], timeout=20, error_msg="No se regreso al prompt de shell tras salir del CLI.")
        print("[*] Ejecutando 'shutdown -r now' para reiniciar el Juniper...")
        child.sendline("shutdown -r now")
        time.sleep(5)

    finally:
        _minicom_exit(child)

    _print_green_banner("CONFIGURACION DEL JUNIPER COMPLETADA EXITOSAMENTE (se esta reiniciando).")
    mark_step_completed("juniper_config", {"juniper_console_device": used_device})


def zpe_config():
    if is_step_completed("zpe_config"):
        print("[=] Paso 'zpe_config' ya fue ejecutado previamente. Omitiendo...")
        return

    requiere("sudo")
    zpe_pass = pass_equipo("zpe_pass")
    print("--- PASO: Configuracion Automatica del ZPE via Consola Serial ---")

    mensaje = (
        "Conecte cable consola al puerto CONSOLE del ZPE y el otro extremo "
        "a un puerto USB 3.0 del Superlogics/ABMX."
    )

    # --- PASO A: Exigir ENTER del usuario y validar el cable de consola antes de continuar ---
    child, used_device = _wait_for_console_connection_enter(mensaje, lista_cfg("consolas"), CFG["zpe_baud"], "cable_zpe")
    child.logfile_read = sys.stdout

    zpe_mac = None
    already_configured = False

    try:
        # --- PASO B: Login automatico (user: admin / password: admin) ---
        # NOTA: los patrones de prompt NO se anclan con '\s*$' porque minicom
        # refresca periodicamente su barra de estado inferior, lo que puede
        # agregar bytes al final del buffer y romper un anclaje estricto al
        # final de la cadena. Basta con que el patron aparezca en el stream.
        print("[*] Buscando prompt de login del ZPE...")
        child.sendline("")
        idx = child.expect([
            r"nodegrid login:",
            r"[Uu]ser(name)?:",
            r"\[[^@\]\s]+@nodegrid[^\]]*\]#\s",
            pexpect.TIMEOUT,
            pexpect.EOF
        ], timeout=20)

        if idx == 0:
            # --- El hostname ya es 'nodegrid' -> el ZPE ya fue configurado previamente ---
            print("[=] Se detecto el prompt 'nodegrid login:': "
                  "esto indica que el ZPE ya se encuentra configurado.")
            already_configured = True
            print(f"[*] Enviando usuario '{CFG['zpe_user']}' para extraer la MAC...")
            child.sendline(CFG["zpe_user"])
            idx2 = child.expect([r"[Pp]ass(word)?:", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
            if idx2 != 0:
                print_ascii_fail()
                raise RuntimeError("No se recibio el prompt 'password:' del ZPE tras enviar el usuario.")
            print("[*] Prompt 'password:' detectado. Enviando password...")
            child.sendline(zpe_pass)
            idx3 = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
            if idx3 != 0:
                print_ascii_fail()
                raise RuntimeError("No se recibio el prompt de shell ('#') del ZPE tras el login.")
        elif idx == 1:
            print(f"[*] Prompt 'user:' detectado. Enviando usuario '{CFG['zpe_user']}'...")
            child.sendline(CFG["zpe_user"])
            idx2 = child.expect([r"[Pp]ass(word)?:", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
            if idx2 != 0:
                print_ascii_fail()
                raise RuntimeError("No se recibio el prompt 'password:' del ZPE tras enviar el usuario.")
            print("[*] Prompt 'password:' detectado. Enviando password...")
            child.sendline(zpe_pass)
            idx3 = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
            if idx3 != 0:
                print_ascii_fail()
                raise RuntimeError("No se recibio el prompt de shell ('#') del ZPE tras el login.")
        elif idx == 2:
            print("[=] La sesion ya se encontraba autenticada en el ZPE.")
        else:
            print_ascii_fail()
            raise RuntimeError("No se detecto el prompt 'user:' del ZPE tras conectar por consola.")

        print("[✓] Login en el ZPE completado.")

        # --- PASO C: Navegar a network_connections y leer la MAC de ETH1 ---
        print("[*] Consultando /settings/network_connections...")
        child.sendline("cd /settings/network_connections")
        idx = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
        if idx != 0:
            print_ascii_fail()
            raise RuntimeError("No se pudo entrar a /settings/network_connections en el ZPE.")

        child.sendline("show")
        idx = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=45)
        if idx != 0:
            print_ascii_fail()
            raise RuntimeError("No se recibio la salida del comando 'show' en el ZPE.")

        show_output = child.before

        eth1_idx = show_output.find("ETH1")
        if eth1_idx == -1:
            print_ascii_fail()
            raise RuntimeError("No se encontro la seccion 'ETH1' en la salida de 'show' del ZPE.")

        section = show_output[eth1_idx:]
        next_eth_idx = section.find("ETH", 4)
        next_hotspot_idx = section.find("hotspot")
        end_candidates = [i for i in (next_eth_idx, next_hotspot_idx) if i != -1]
        section = section[:min(end_candidates)] if end_candidates else section

        mac_matches = re.findall(r'([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})', section)
        if not mac_matches:
            print_ascii_fail()
            raise RuntimeError("No se pudo extraer la direccion MAC de ETH1 en la salida del ZPE.")

        zpe_mac = mac_matches[0].lower()
        print(f"[+] MAC ETH1 (ZPE) detectada: {zpe_mac}")

    finally:
        # --- PASO D: Salir de minicom (Ctrl+A, X). Se ejecuta una sola vez,
        # tanto en el camino exitoso como en cualquier fallo anterior. ---
        _minicom_exit(child)

    # --- PASO E: (se marca como hecho hasta el final, antes se marcaba aquí y si fallaba el DHCP se saltaba)
    datos_zpe = {"zpe_console_device": used_device, "zpe_mac": zpe_mac, "zpe_already_configured": already_configured}

    # --- PASO F: Actualizar /etc/dhcp/dhcpd.conf con la MAC real del ZPE ---
    print("[*] Actualizando /etc/dhcp/dhcpd.conf con la MAC real del ZPE...")
    _set_dhcp_host_mac("zpe", zpe_mac, CFG["zpe_ip"])

    print("[*] Reiniciando servicios DHCP (IPv4 e IPv6)...")
    run_interactive("sudo systemctl restart isc-dhcp-server")
    run_interactive("sudo systemctl restart isc-dhcp-server6")

    # Si ya estaba configurado previamente, omitimos únicamente el script masivo de puertos por SSH
    if already_configured:
        _print_green_banner(
            "EL ZPE YA ESTABA CONFIGURADO. Se extrajo la MAC y se actualizó el DHCP, "
            "omitiendo la ejecución del script de configuración de puertos por SSH."
        )
        mark_step_completed("zpe_config", datos_zpe)
        return

    # --- PASO G: Ejecutar script de configuracion de todos los puertos del ZPE via SSH ---
    zpe_script_dir = en_home(CFG["zpe_script_dir"])
    ssh_cmd = (
        f"cd {zpe_script_dir} && "
        f"ssh -t -t -v -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new {CFG['zpe_user']}@{CFG['zpe_ip']} < {CFG['zpe_script']}"
    )
    print(f"[CMD Interactive] {ssh_cmd}")
    ssh_child = pexpect.spawn("bash", ["-c", ssh_cmd], encoding="utf-8", timeout=600)
    ssh_child.logfile_read = sys.stdout

    idx = ssh_child.expect([
        r"[Pp]assword:",
        pexpect.EOF,
        pexpect.TIMEOUT
    ], timeout=60)

    if idx == 0:
        print("[*] Prompt de password SSH detectado. Enviando password...")
        ssh_child.sendline(zpe_pass)
        idx2 = ssh_child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=540)
        if idx2 != 0:
            print_ascii_fail()
            ssh_child.close(force=True)
            raise RuntimeError(f"Timeout esperando que finalice {CFG['zpe_script']} via SSH.")
    elif idx == 1:
        print("[=] La sesion SSH finalizo sin solicitar password (posible autenticacion por llave).")
    else:
        print_ascii_fail()
        ssh_child.close(force=True)
        raise RuntimeError(f"Timeout esperando el prompt de password SSH hacia el ZPE ({CFG['zpe_ip']}).")

    ssh_child.close()
    if ssh_child.exitstatus not in (0, None):
        print_ascii_fail()
        raise RuntimeError(
            f"Error ejecutando {CFG['zpe_script']} via SSH (Exit code: {ssh_child.exitstatus})"
        )

    _print_green_banner("CONFIGURACION DEL ZPE COMPLETADA EXITOSAMENTE.")
    mark_step_completed("zpe_config", datos_zpe)
    
def _scp_download_once(remote_user, remote_host, remote_path, destination="."):
    cmd = f"scp -r {remote_user}@{remote_host}:{remote_path} {destination}"
    print(f"[CMD Interactive] {cmd}")

    child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=None)
    child.logfile_read = sys.stdout

    while True:
        idx = child.expect([
            r"Are you sure you want to continue connecting",
            r"[pP]assword:",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=600)

        if idx == 0:
            child.sendline("yes")
        elif idx == 1:
            child.sendline(SUDO_PASSWORD)
        elif idx == 2:
            break
        elif idx == 3:
            child.close(force=True)
            raise RuntimeError(f"Timeout copiando '{remote_path}' desde {remote_host}.")

    child.close()
    if child.exitstatus != 0:
        raise RuntimeError(
            f"Error copiando '{remote_path}' desde {remote_host} (Exit code: {child.exitstatus})."
        )

def _scp_download(remote_user, remote_host, remote_path, destination="."):
    """Descarga (recursivamente) 'remote_path' desde 'remote_user@remote_host' hacia
    'destination' via scp, manejando el prompt de huella SSH y de contrasena
    (se usa SUDO_PASSWORD, siguiendo la misma convencion que run_scp_from_mirror
    y download_python_tools). Con reintentos (backoff exponencial) ante fallos
    transitorios de red; el banner de FALLO solo se muestra si se agotan
    todos los intentos."""
    try:
        _retry_download(
            lambda: _scp_download_once(remote_user, remote_host, remote_path, destination),
            f"SCP de '{remote_path}' desde {remote_host}"
        )
    except RuntimeError:
        print_ascii_fail(f"No se pudo copiar '{remote_path}' desde {remote_host}.")
        raise

def _run_shell_sequence(commands, timeout=600):
    """Ejecuta 'commands' UNO POR UNO (sin encadenarlos con '&&' en una sola linea)
    dentro de una UNICA sesion de bash persistente, para que efectos como 'cd'
    se mantengan de un comando al siguiente, igual que si se tecleasen a mano
    en una terminal. Maneja automaticamente cualquier prompt de 'sudo' que
    aparezca en medio de la secuencia."""
    print("[*] Ejecutando secuencia de comandos (sesion de shell persistente):")
    for c in commands:
        print(f"    $ {c}")

    child = pexpect.spawn("bash", encoding="utf-8", timeout=timeout)
    child.logfile_read = sys.stdout

    try:
        for cmd in commands:
            marker = f"__CMDDONE_{uuid.uuid4().hex}__"
            # Se envia el comando y el marcador de finalizacion en una sola
            # linea compuesta (una unica llamada a sendline). Si se enviaran
            # en dos sendline() separados, y 'cmd' dispara un prompt de sudo,
            # el segundo sendline podria "colarse" como si fuera la respuesta
            # al prompt de contrasena, ya que sudo lee directo de la terminal.
            child.sendline(f"{cmd}; echo {marker}$?")

            exit_code = None
            while exit_code is None:
                idx = child.expect([
                    rf"{marker}(\d+)",
                    r"\[sudo\] password for .*:?",
                    r"[pP]assword:",
                    pexpect.TIMEOUT,
                    pexpect.EOF
                ], timeout=timeout)

                if idx == 0:
                    exit_code = int(child.match.group(1))
                elif idx in (1, 2):
                    child.sendline(SUDO_PASSWORD)
                else:
                    print_ascii_fail()
                    raise RuntimeError(f"Timeout/EOF ejecutando '{cmd}' en la secuencia de shell.")

            if exit_code != 0:
                print_ascii_fail()
                raise RuntimeError(f"El comando '{cmd}' fallo con codigo de salida {exit_code}.")
    finally:
        try:
            child.sendline("exit")
            child.close(force=True)
        except Exception:
            pass

def vrmu_util_config():
    if is_step_completed("vrmu_util_config"):
        print("[=] Paso 'vrmu_util_config' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO: Descarga y configuracion de VRMU Util / Viperfish-DVC ---")

    remote_host = CFG["vrmu_host"]
    sudo_user = usuario()
    remote_user = sudo_user
    home_dir = home()

    # --- PASO 1: Descargar por SCP los directorios/archivos necesarios ---
    items_to_download = lista_cfg("vrmu_items")

    for item in items_to_download:
        remote_path = f"/home/{remote_user}/{item}"
        print(f"[*] Descargando '{item}' desde {remote_host}...")
        _scp_download(remote_user, remote_host, remote_path, destination=home_dir)

    # --- PASO 2: Copiar la imagen 'tross' de viperfish-dvc/vin-sweep a /tftpboot/ ---
    # Comandos enviados por separado (no encadenados con '&&'), como pasos independientes.
    # /tftpboot/ requiere permisos elevados, de ahi el 'sudo' en el cp.
    print("[*] Copiando imagen 'tross' a /tftpboot/...")
    _run_shell_sequence([
        f"cd {home_dir}/viperfish-dvc/vin-sweep/",
        "sudo mkdir -p /tftpboot",
        "sudo cp -r tross /tftpboot/",
    ])

    # --- PASO 3: Copiar vrmu_util al home del usuario y darle permisos de ejecucion ---
    # Comandos enviados por separado (no encadenados con '&&'), como pasos independientes.
    print("[*] Copiando vrmu_util al home y asignando permisos...")

    # Se descarga directo al home: solo falta darle permisos (antes 777; con 755 basta)
    _run_shell_sequence([f"chmod 755 {home_dir}/vrmu_util"])

    print("[✓] Configuracion de VRMU Util completada exitosamente.")
    mark_step_completed("vrmu_util_config")

def tross_capture_mac():
    if is_step_completed("tross_capture_mac"):
        print("[=] Paso 'tross_capture_mac' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO: Captura de la MAC del Tross ---")
    mac_input = (os.environ.get("GF_TROSS_MAC") or "").strip()
    while True:
        if not mac_input:
            _print_yellow_banner("Por favor, introduzca la direccion MAC del Tross.")
            mac_input = pedir("tross_mac", "MAC del Tross (viene en la etiqueta):").strip()
        # Se queda solo con los caracteres hexadecimales, sin importar el separador
        clean_mac = re.sub(r'[^0-9a-fA-F]', '', mac_input)
        if len(clean_mac) == 12:
            break
        print(f"[!] La MAC ingresada no es valida (se esperaban 12 caracteres hexadecimales, "
              f"se obtuvieron {len(clean_mac)}): '{mac_input}'")
        if not EN_APP:
            print_ascii_fail("MAC del Tross no valida.")
            raise ValueError(f"MAC del Tross no valida: '{mac_input}'")
        mac_input = ""

    tross_mac = ":".join(clean_mac[i:i + 2] for i in range(0, 12, 2)).lower()
    print(f"[+] MAC normalizada del Tross: {tross_mac}")

    # Primero se aplica en el DHCP y hasta el final se marca (antes se marcaba antes y si fallaba se saltaba)
    print("[*] Actualizando /etc/dhcp/dhcpd.conf con la MAC real del Tross...")
    _set_dhcp_host_mac("tross", tross_mac, CFG["tross_ip"])
    print("[*] Reiniciando servicios DHCP (IPv4 e IPv6)...")
    run_interactive("sudo systemctl restart isc-dhcp-server")
    run_interactive("sudo systemctl restart isc-dhcp-server6")

    mark_step_completed("tross_capture_mac", {"tross_mac": tross_mac})
    print("[✓] MAC del Tross capturada y aplicada exitosamente.")

class _Pausa(Exception):
    """El paso se detiene a proposito (ej. hay que hacer power cycle del rack) y se retoma en la siguiente corrida."""
    pass

# Acepta cualquier hostname entre "root@" y ":" (vacio, "(none)" o uno real),
# ya que varia segun el momento del boot.
TROSS_PROMPT = r"root@[^:\r\n]*:[^\r\n]*"

# Ancla "=>" al inicio de linea y al final del buffer, para no confundirlo
# con apariciones de "=>" dentro del log normal de boot (ej. "bootCount 0 => 1").
UBOOT_PROMPT = r"\r\n=> $"

# Aviso del gateway de consola del ZPE (Nodegrid) cuando la sesion queda en
# modo solo lectura: ninguna tecla enviada llega al Tross. La unica
# recuperacion conocida en ese caso es reiniciar el propio ZPE.
ZPE_READONLY_MARKER = "[read-only -- use ^X t ? for help]"

class _ZpeConsoleReadOnlyError(RuntimeError):
    """Consola del ZPE atascada en modo solo lectura. TROSS_CONFIG() la
    captura para pedir el reinicio del ZPE y reintentar."""
    pass

def _paced_sendline(child, line, delay=0.4):
    """Envia una linea a la consola con una breve pausa posterior, para no
    saturar al equipo remoto con comandos consecutivos."""
    child.sendline(line)
    time.sleep(delay)

def _print_red_banner(message):
    """Imprime un mensaje de alerta en rojo con borde. A diferencia de
    print_ascii_fail(), soporta mensajes multilinea."""
    RED = "\033[91m\033[1m"
    RESET = "\033[0m"
    border = "=" * 80
    print(f"\n{RED}{border}")
    for line in message.split("\n"):
        print(f"[!] {line}")
    print(f"{border}{RESET}\n")

def _green_wait(seconds, label="Esperando"):
    """Espera 'seconds' segundos mostrando un contador regresivo en verde."""
    GREEN = "\033[92m"
    RESET = "\033[0m"
    print(f"[*] {label}: esperando {seconds}s...")
    start = time.time()
    while True:
        elapsed = int(time.time() - start)
        if elapsed >= seconds:
            break
        remaining = seconds - elapsed
        sys.stdout.write(f"\r{GREEN}[{label}] Tiempo restante: {remaining}s...{RESET}")
        sys.stdout.flush()
        time.sleep(1)
    sys.stdout.write(f"\r{GREEN}[{label}] Completado.{' ' * 20}{RESET}\n")

def _update_state_config(extra):
    """Actualiza state['config'] sin marcar ningun paso como completado."""
    state = load_state()
    state.setdefault("config", {}).update(extra)
    save_state(state)

def _mac_plus_offset(mac, offset):
    """Suma 'offset' al ultimo octeto de una MAC ('xx:xx:xx:xx:xx:xx')."""
    parts = mac.split(":")
    last = (int(parts[-1], 16) + offset) % 256
    parts[-1] = f"{last:02x}"
    return ":".join(parts)

def _zpe_console_take_control(child):
    """Toma control de escritura de un puerto de consola relay del ZPE que
    abrio en modo solo lectura, con la secuencia Ctrl-X, t."""
    print("[*] Tomando control de escritura de la consola (Ctrl-X, t)...")
    child.send(chr(0x18))  # Ctrl-X
    time.sleep(0.3)
    child.send("t")
    time.sleep(0.3)

def _drain_buffered_output(child, idle_timeout=0.3):
    """Descarta el scrollback ya bufferizado en la sesion (el ZPE lo vuelca
    al conectar) leyendo en modo no bloqueante hasta que no llegue nada
    nuevo durante 'idle_timeout'."""
    try:
        while True:
            child.read_nonblocking(size=65536, timeout=idle_timeout)
    except pexpect.exceptions.TIMEOUT:
        pass
    except pexpect.exceptions.EOF:
        pass

def _open_zpe_console_telnet(port, timeout=45, take_control=False):
    """Abre una sesion telnet al puerto serial relay del ZPE (Nodegrid) que
    da acceso a la consola del Tross conectada fisicamente al puerto 17.

    take_control=True manda la toma de control (Ctrl-X, t) justo despues de
    conectar; usar solo cuando la conexion se abre antes de un boot en vivo,
    ya que enviarla sobre un prompt idle ('=>' o 'root@:') contamina el
    buffer de comandos del equipo. La toma de control reactiva (solo si se
    detecta el aviso de solo lectura) vive en _tross_ensure_logged_in."""
    cmd = f"telnet {CFG['zpe_ip']} {port}"
    print(f"[CMD Interactive] {cmd}")
    child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=timeout)
    child.logfile_read = sys.stdout
    idx = child.expect([r"Escape character is", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
    if idx != 0:
        # La conexion misma fallo (ZPE inalcanzable, "No route to host",
        # "Connection refused", etc.) o nunca respondio. Cortamos aca con un
        # error claro en vez de seguir de largo (toma de control, pedido de
        # reinicio fisico, espera de autoboot) sobre una sesion muerta, que
        # termina fallando mas tarde con un mensaje que no refleja la causa real.
        output = (child.before or "").strip()
        try:
            child.close(force=True)
        except Exception:
            pass
        print_ascii_fail(
            f"No se pudo conectar a la consola del ZPE (telnet {CFG['zpe_ip']} {port}). "
            f"Verifique que el ZPE este encendido y accesible en la red."
        )
        raise RuntimeError(
            f"No se pudo abrir la consola del ZPE ({CFG['zpe_ip']}:{port}): {output or 'sin respuesta'}"
        )
    if take_control:
        _zpe_console_take_control(child)
    _drain_buffered_output(child)
    return child

def _zpe_console_exit(child):
    """Sale de una sesion de consola relay del ZPE con Ctrl+5 seguido de 'q'.
    Segura de llamar mas de una vez sobre el mismo 'child'."""
    if child is None or getattr(child, "closed", False):
        return
    print("[*] Saliendo de la consola relay del ZPE (Ctrl+5, q)...")
    try:
        child.send(chr(0x1D))  # Ctrl+5
        time.sleep(0.5)
        child.sendline("q")
        child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=15)
    except Exception as e:
        print(f"[!] Advertencia: no se pudo confirmar la salida limpia de la consola del ZPE ({e}).")
    finally:
        try:
            child.close(force=True)
        except Exception:
            pass
        if not EN_APP:
            os.system("clear")

def _uboot_break_spam(child, max_seconds=180, spam_window=25):
    """Interrumpe el autoboot del Tross. Espera en silencio (sin enviar
    teclas) hasta leer 'Hit any key to stop autoboot:', y recien ahi manda
    teclas de interrupcion durante 'spam_window' segundos. Enter y espacio
    son las unicas teclas validas: las teclas de control (Ctrl-C, Ctrl-X,
    etc.) son interceptadas por el gateway de consola del ZPE antes de
    llegar al equipo."""
    print("[*] Esperando (sin enviar teclas aun) el mensaje 'Hit any key to stop autoboot:' del Tross...")
    idx = child.expect([r"Hit any key to stop autoboot", pexpect.TIMEOUT, pexpect.EOF], timeout=max_seconds)
    if idx != 0:
        print_ascii_fail("No se recibio el mensaje 'Hit any key to stop autoboot:' del Tross.")
        raise RuntimeError("Timeout esperando 'Hit any key to stop autoboot:' en el Tross.")

    print("[✓] 'Hit any key to stop autoboot:' detectado. Probando teclas de interrupcion...")
    candidate_keys = ["\r", " "]
    deadline = time.time() + spam_window
    i = 0
    while time.time() < deadline:
        key = candidate_keys[i % len(candidate_keys)]
        i += 1
        child.send(key)
        idx = child.expect([UBOOT_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=0.2)
        if idx == 0:
            print("[✓] Prompt '=>' de U-Boot detectado.")
            return
        if idx == 2:
            print_ascii_fail(
                "La sesion de consola se cerro inesperadamente al intentar interrumpir el "
                "autoboot (posible tecla reservada por el gateway del ZPE)."
            )
            raise RuntimeError("EOF inesperado interrumpiendo el autoboot del Tross.")
        if ZPE_READONLY_MARKER in (child.before or ""):
            print_ascii_fail(
                "La consola del ZPE quedo en modo solo-lectura: ninguna tecla llega al Tross."
            )
            raise _ZpeConsoleReadOnlyError(
                "La consola relay del ZPE esta en modo solo-lectura (aviso "
                f"'{ZPE_READONLY_MARKER}' detectado)."
            )
    print_ascii_fail(
        "Se detecto 'Hit any key to stop autoboot:' pero no se logro interrumpir el "
        "arranque (nunca aparecio el prompt '=>')."
    )
    raise RuntimeError("No se pudo interrumpir el autoboot del Tross a tiempo.")

def _uboot_cmd_check(child, cmd, expected_substrings, timeout=45, fail_msg=None):
    """Envia 'cmd' en U-Boot y valida que TODAS las cadenas en
    'expected_substrings' (str o lista) aparezcan en la respuesta antes del
    siguiente prompt '=>'. Si no, banner de fallo + RuntimeError."""
    if isinstance(expected_substrings, str):
        expected_substrings = [expected_substrings]
    print(f"[CMD U-Boot] {cmd}")
    _paced_sendline(child, cmd)
    idx = child.expect([UBOOT_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=timeout)
    output = child.before or ""
    if idx != 0 or not all(s in output for s in expected_substrings):
        print_ascii_fail(fail_msg or f"Respuesta inesperada del Tross tras el comando '{cmd}'.")
        raise RuntimeError(f"Fallo validando la respuesta de U-Boot para '{cmd}'.")
    print(f"[✓] Respuesta validada para '{cmd}'.")
    return output

def _wait_for_pattern_with_enters(child, pattern, max_seconds, interval=5, label="Esperando"):
    """Envia ENTER cada 'interval' segundos (hasta 'max_seconds' en total)
    mostrando un contador en verde, hasta que 'pattern' aparezca en el stream.
    Devuelve True si se encontro el patron, False si se agoto el tiempo."""
    GREEN = "\033[92m"
    RESET = "\033[0m"
    elapsed = 0
    while elapsed < max_seconds:
        child.sendline("")
        idx = child.expect([pattern, pexpect.TIMEOUT, pexpect.EOF], timeout=interval)
        if idx == 0:
            sys.stdout.write(f"\r{GREEN}[{label}] Completado en {elapsed}s.{' ' * 20}{RESET}\n")
            return True
        if idx == 2:
            return False
        if ZPE_READONLY_MARKER in (child.before or ""):
            print_ascii_fail(
                "La consola del ZPE quedo en modo solo-lectura: ninguna tecla llega al Tross."
            )
            raise _ZpeConsoleReadOnlyError(
                "La consola relay del ZPE esta en modo solo-lectura (aviso "
                f"'{ZPE_READONLY_MARKER}' detectado)."
            )
        elapsed += interval
        sys.stdout.write(f"\r{GREEN}[{label}] Tiempo transcurrido: {elapsed}s (max {max_seconds}s)...{RESET}")
        sys.stdout.flush()
    sys.stdout.write(f"\r{GREEN}[{label}] Tiempo agotado tras {max_seconds}s.{' ' * 20}{RESET}\n")
    return False

def _wait_silently_for_pattern(child, pattern, max_seconds, poll_interval=5, label="Esperando"):
    """Como _wait_for_pattern_with_enters, pero sin enviar ninguna tecla
    mientras espera. Se usa tras un 'reset' real: cualquier tecla enviada
    durante la ventana 'Hit any key to stop autoboot' interrumpiria el
    autoboot en vez de dejarlo avanzar solo hasta 'login:'."""
    GREEN = "\033[92m"
    RESET = "\033[0m"
    elapsed = 0
    while elapsed < max_seconds:
        idx = child.expect([pattern, pexpect.TIMEOUT, pexpect.EOF], timeout=poll_interval)
        if idx == 0:
            sys.stdout.write(f"\r{GREEN}[{label}] Completado en {elapsed}s.{' ' * 20}{RESET}\n")
            return True
        if idx == 2:
            return False
        elapsed += poll_interval
        sys.stdout.write(f"\r{GREEN}[{label}] Tiempo transcurrido: {elapsed}s (max {max_seconds}s)...{RESET}")
        sys.stdout.flush()
    sys.stdout.write(f"\r{GREEN}[{label}] Tiempo agotado tras {max_seconds}s.{' ' * 20}{RESET}\n")
    return False

def _run_tross_cmd_and_wait(child, cmd, max_wait_seconds, poll_interval=5, label="Esperando",
                             prompt_pattern=None):
    """Envia 'cmd' dentro de la sesion del Tross y espera a que regrese el
    prompt (por defecto TROSS_PROMPT), mostrando un contador en verde mientras
    dura la espera. Devuelve el texto acumulado (child.before) una vez que el
    prompt aparece. Lanza RuntimeError si se agota 'max_wait_seconds' o si la
    sesion se cierra (EOF) antes de tiempo."""
    prompt_pattern = prompt_pattern or TROSS_PROMPT
    GREEN = "\033[92m"
    RESET = "\033[0m"
    print(f"[CMD Tross] {cmd}")
    _paced_sendline(child, cmd)
    elapsed = 0
    while True:
        idx = child.expect([prompt_pattern, pexpect.TIMEOUT, pexpect.EOF], timeout=poll_interval)
        if idx == 0:
            sys.stdout.write(f"\r{GREEN}[{label}] Completado en {elapsed}s.{' ' * 20}{RESET}\n")
            return child.before or ""
        if idx == 2:
            print_ascii_fail(f"La sesion del Tross se cerro inesperadamente durante '{cmd}'.")
            raise RuntimeError(f"EOF inesperado esperando la finalizacion de '{cmd}'.")
        if ZPE_READONLY_MARKER in (child.before or ""):
            print_ascii_fail(
                "La consola del ZPE quedo en modo solo-lectura: ninguna tecla llega al Tross."
            )
            raise _ZpeConsoleReadOnlyError(
                "La consola relay del ZPE esta en modo solo-lectura (aviso "
                f"'{ZPE_READONLY_MARKER}' detectado)."
            )
        elapsed += poll_interval
        sys.stdout.write(f"\r{GREEN}[{label}] Tiempo transcurrido: {elapsed}s (max {max_wait_seconds}s)...{RESET}")
        sys.stdout.flush()
        if elapsed >= max_wait_seconds:
            print_ascii_fail(f"Timeout esperando que finalice '{cmd}' en el Tross.")
            raise RuntimeError(f"Timeout ({max_wait_seconds}s) esperando la finalizacion de '{cmd}'.")

def _run_local_cmd_with_wait(cmd, max_wait_seconds, poll_interval=10, label="Esperando"):
    """Ejecuta 'cmd' localmente (bash -c) mostrando un contador en verde
    mientras corre, hasta 'max_wait_seconds'. Devuelve (output, exit_code)
    sin lanzar excepcion por codigo de salida no-cero (el llamador decide
    que hacer con la salida, ya que aqui lo relevante es el TEXTO de
    respuesta, no solo el exit code)."""
    GREEN = "\033[92m"
    RESET = "\033[0m"
    marker = f"__CMDDONE_{uuid.uuid4().hex}__"
    print(f"[CMD Local] {cmd}")
    child = pexpect.spawn("bash", ["-c", f"{cmd}; echo {marker}$?"], encoding="utf-8",
                           timeout=max_wait_seconds + 60)
    child.logfile_read = sys.stdout
    elapsed = 0
    while True:
        idx = child.expect([rf"{marker}(\d+)", pexpect.TIMEOUT, pexpect.EOF], timeout=poll_interval)
        if idx == 0:
            exit_code = int(child.match.group(1))
            output = child.before or ""
            child.close(force=True)
            sys.stdout.write(f"\r{GREEN}[{label}] Completado en {elapsed}s.{' ' * 20}{RESET}\n")
            return output, exit_code
        if idx == 2:
            child.close(force=True)
            print_ascii_fail(f"La sesion local se cerro inesperadamente ejecutando '{cmd}'.")
            raise RuntimeError(f"EOF inesperado ejecutando '{cmd}'.")
        elapsed += poll_interval
        sys.stdout.write(f"\r{GREEN}[{label}] Tiempo transcurrido: {elapsed}s (max {max_wait_seconds}s)...{RESET}")
        sys.stdout.flush()
        if elapsed >= max_wait_seconds:
            child.close(force=True)
            print_ascii_fail(f"Timeout esperando que finalice '{cmd}'.")
            raise RuntimeError(f"Timeout ({max_wait_seconds}s) esperando la finalizacion de '{cmd}'.")

def _tross_do_login(child):
    """Ingresa las credenciales root/google en el prompt 'login:' del Tross
    y deja la sesion en TROSS_PROMPT. Factorizado porque se usa desde varias
    etapas (boot inicial, tras 'reset' post-imager, y desde el resumen de
    sesion _tross_ensure_logged_in)."""
    print(f"[*] Ingresando credenciales de login ({CFG['tross_user']})...")
    _paced_sendline(child, CFG["tross_user"])
    idx = child.expect([r"[Pp]assword:", pexpect.TIMEOUT, pexpect.EOF], timeout=20)
    if idx != 0:
        print_ascii_fail()
        raise RuntimeError("No se recibio el prompt 'Password:' del Tross tras el usuario 'root'.")
    child.logfile_read = None          # que la contrasena no salga en la consola
    _paced_sendline(child, pass_equipo("tross_pass"))
    child.logfile_read = sys.stdout
    idx = child.expect([TROSS_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=20)
    if idx != 0:
        print_ascii_fail()
        raise RuntimeError(f"No se pudo iniciar sesion en el Tross ({CFG['tross_user']}). Revisa la contrasena en Valores.")

def _tross_netboot_and_login(child):
    """Desde el prompt '=>' de U-Boot, corre el boot por red (netboot) hacia
    el kernel del Tross, espera el prompt 'login:' y loguea. Se asume que el
    U-Boot ya fue flasheado (etapa 'tross_uboot_flashed')."""
    _paced_sendline(
        child, f"setenv ipaddr {CFG['tross_ip']};setenv netmask {CFG['tross_netmask']};setenv gatewayip {CFG['tftp_server']}"
    )
    child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)
    _paced_sendline(child, f"setenv serverip {CFG['tftp_server']}")
    child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)
    _paced_sendline(child, "setenv goog_boot netboot;setenv verify-sig 0;run set_ramboot")
    child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)
    print(f"[CMD U-Boot] tftpboot 0x70000000 {CFG['kernel_file']};run boot_kernel")
    _paced_sendline(child, f"tftpboot 0x70000000 {CFG['kernel_file']};run boot_kernel")

    if not _wait_for_pattern_with_enters(child, r"login:", max_seconds=180, interval=5,
                                          label="Esperando prompt 'login:' del Tross"):
        print_ascii_fail("No se recibio el prompt 'login:' del Tross tras el boot por red.")
        raise RuntimeError("Timeout esperando el prompt 'login:' del Tross.")

    _tross_do_login(child)

def _tross_ensure_logged_in(child):
    """Punto de entrada comun para dejar al Tross logueado (TROSS_PROMPT) al
    reconectar la consola, ya sea la primera vez en la etapa o al resumir
    una corrida anterior. Detecta el estado de la sesion y hace lo minimo
    necesario para llegar a un prompt de shell:
      - Ya esta en TROSS_PROMPT -> no hace nada.
      - Esta en 'login:' -> loguea directamente.
      - Esta en '=>' de U-Boot -> corre el netboot completo y loguea.
      - Esta en plena ventana 'Hit any key to stop autoboot' -> espera en
        silencio a que el autoboot termine solo, sin interrumpirlo.

    Si el sondeo inicial no reconoce ningun estado y se detecta el aviso de
    sesion solo lectura del ZPE, reintenta la toma de control una vez antes
    de escalar a _ZpeConsoleReadOnlyError."""
    idx = child.expect([
        TROSS_PROMPT, r"login:", UBOOT_PROMPT, r"Hit any key to stop autoboot",
        pexpect.TIMEOUT, pexpect.EOF
    ], timeout=5)
    if idx == 3:
        print("[!] Se detecto la ventana 'Hit any key to stop autoboot' al reconectar. "
              "Esperando en silencio a que el autoboot termine solo...")
        if not _wait_silently_for_pattern(child, r"login:", max_seconds=210, poll_interval=5,
                                           label="Esperando 'login:' (autoboot en curso al reconectar)"):
            print_ascii_fail("No se recibio el prompt 'login:' tras esperar el autoboot al reconectar.")
            raise RuntimeError("Timeout esperando 'login:' tras reconectar en plena ventana de autoboot.")
        _tross_do_login(child)
        return
    if idx == 0:
        print("[=] La sesion del Tross ya estaba logueada.")
        return
    if idx == 1:
        print("[*] La sesion del Tross esta en el prompt 'login:'. Ingresando credenciales...")
        _tross_do_login(child)
        return
    if idx == 2:
        print("[*] La sesion del Tross esta en el prompt '=>' de U-Boot. Booteando Linux por red...")
        _tross_netboot_and_login(child)
        return

    # Sin match en el sondeo pasivo: se manda un ENTER y se vuelve a sondear.
    _paced_sendline(child, "")
    idx = child.expect([TROSS_PROMPT, r"login:", UBOOT_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=30)
    if idx == 0:
        print("[=] La sesion del Tross ya estaba logueada.")
        return
    if idx == 1:
        print("[*] La sesion del Tross esta en el prompt 'login:'. Ingresando credenciales...")
        _tross_do_login(child)
        return
    if idx == 2:
        print("[*] La sesion del Tross esta en el prompt '=>' de U-Boot. Booteando Linux por red...")
        _tross_netboot_and_login(child)
        return

    saw_readonly = ZPE_READONLY_MARKER in (child.before or "")
    if saw_readonly:
        print("[!] Se detecto el aviso de sesion solo-lectura. Reintentando toma de control (Ctrl-X, t)...")
        _zpe_console_take_control(child)
        _drain_buffered_output(child)
        _paced_sendline(child, "")
        idx = child.expect([TROSS_PROMPT, r"login:", UBOOT_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=30)
        if idx == 0:
            print("[=] La sesion del Tross ya estaba logueada.")
            return
        if idx == 1:
            print("[*] La sesion del Tross esta en el prompt 'login:'. Ingresando credenciales...")
            _tross_do_login(child)
            return
        if idx == 2:
            print("[*] La sesion del Tross esta en el prompt '=>' de U-Boot. Booteando Linux por red...")
            _tross_netboot_and_login(child)
            return
        if ZPE_READONLY_MARKER in (child.before or ""):
            print_ascii_fail(
                "La consola del ZPE sigue en modo solo-lectura tras reintentar la toma de control."
            )
            raise _ZpeConsoleReadOnlyError(
                "La consola relay del ZPE esta en modo solo-lectura (aviso "
                f"'{ZPE_READONLY_MARKER}' detectado) tras reconectar."
            )

    print_ascii_fail("No se pudo determinar el estado actual de la sesion del Tross al reconectar.")
    raise RuntimeError("Estado desconocido de la sesion del Tross al reconectar.")

def _tross_reconfigure_zpe_eth1():
    """Se conecta por SSH a admin@10.0.0.253 (ZPE) y configura ETH1 en modo
    estatico (10.0.0.253/8, gateway 10.0.0.254), validando el 'show' contra
    la respuesta esperada, y hace 'commit' + 'exit' confirmando la perdida de
    cambios no comiteados con 'yes'."""
    print(f"[*] Conectando por SSH a {CFG['zpe_user']}@{CFG['zpe_ip']} para reconfigurar ETH1...")
    ssh_cmd = f"ssh -o StrictHostKeyChecking=accept-new {CFG['zpe_user']}@{CFG['zpe_ip']}"
    print(f"[CMD Interactive] {ssh_cmd}")
    child = pexpect.spawn("bash", ["-c", ssh_cmd], encoding="utf-8", timeout=60)
    child.logfile_read = sys.stdout

    idx = child.expect([
        r"Are you sure you want to continue connecting",
        r"[Pp]assword:",
        pexpect.TIMEOUT,
        pexpect.EOF
    ], timeout=45)

    if idx == 0:
        child.sendline("yes")
        idx = child.expect([r"[Pp]assword:", pexpect.TIMEOUT, pexpect.EOF], timeout=45)
        if idx != 0:
            print_ascii_fail()
            raise RuntimeError("No se recibio el prompt de password SSH del ZPE tras aceptar el fingerprint.")
    elif idx != 1:
        print_ascii_fail()
        raise RuntimeError(f"No se recibio el prompt de password SSH del ZPE ({CFG['zpe_ip']}).")

    print("[*] Enviando password del ZPE...")
    child.sendline(pass_equipo("zpe_pass"))
    idx = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=45)
    if idx != 0:
        print_ascii_fail()
        raise RuntimeError(f"No se pudo autenticar por SSH contra el ZPE ({CFG['zpe_ip']}). Revisa la contrasena en Valores.")

    commands = [
        "cd /settings/network_connections/ETH1",
        "set ipv4_mode=static",
        f"set ipv4_address={CFG['zpe_ip']}",
        f"set ipv4_bitmask={CFG['zpe_eth1_bitmask']}",
        f"set ipv4_gateway={CFG['zpe_gateway']}",
    ]
    for cmd in commands:
        child.sendline(cmd)
        idx = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=30)
        if idx != 0:
            print_ascii_fail()
            child.close(force=True)
            raise RuntimeError(f"El ZPE no respondio como se esperaba tras el comando '{cmd}'.")

    child.sendline("show")
    idx = child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=30)
    if idx != 0:
        print_ascii_fail()
        child.close(force=True)
        raise RuntimeError("No se recibio la salida del comando 'show' tras configurar ETH1.")

    show_output = child.before or ""
    required_lines = [
        "name: ETH1",
        "type: ethernet",
        "ethernet_interface = eth1",
        "ipv4_mode = static",
        f"ipv4_address = {CFG['zpe_ip']}",
        f"ipv4_bitmask = {CFG['zpe_eth1_bitmask']}",
        f"ipv4_gateway = {CFG['zpe_gateway']}",
    ]
    if not all(line in show_output for line in required_lines):
        print_ascii_fail(
            "La salida de 'show' en ETH1 no coincide con lo esperado tras la "
            "reconfiguracion. Se requiere revisión manual (atencion del operador)."
        )
        child.close(force=True)
        raise RuntimeError("Validacion de 'show' en ETH1 fallo tras la reconfiguracion del ZPE.")

    print("[✓] Configuracion de ETH1 validada correctamente.")

    child.sendline("commit")
    child.expect([r"#\s", pexpect.TIMEOUT, pexpect.EOF], timeout=45)

    child.sendline("exit")
    idx = child.expect([
        r"Uncommited changes will be lost\. Confirm exit\? \(yes, no\)",
        r"#\s",
        pexpect.TIMEOUT,
        pexpect.EOF
    ], timeout=20)
    if idx == 0:
        child.sendline("yes")
        child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=20)

    child.close(force=True)
    print("[✓] Sesion SSH hacia el ZPE cerrada.")

def _tross_stage_dhcp(tross_mac):
    """ETAPA 1/13: aplicar la MAC del Tross en /etc/dhcp/dhcpd.conf y
    reiniciar los servicios DHCP."""
    if is_tross_step_completed("tross_dhcp_applied"):
        print("[=] Etapa 'tross_dhcp_applied' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 1/13: Aplicar la MAC del Tross en /etc/dhcp/dhcpd.conf ---")

    print(f"[*] Asegurando que /etc/dhcp/dhcpd.conf tenga la MAC del Tross ({tross_mac})...")
    _set_dhcp_host_mac("tross", tross_mac, CFG["tross_ip"])

    print("[*] Reiniciando servicios DHCP (IPv4 e IPv6)...")
    run_interactive("sudo systemctl restart isc-dhcp-server")
    run_interactive("sudo systemctl restart isc-dhcp-server6")

    mark_tross_step_completed("tross_dhcp_applied")

def _tross_stage_flash_uboot():
    """ETAPA 2/13: conectar la consola, pedir el reinicio fisico manual del
    Tross, interrumpir el autoboot, flashear U-Boot (sf probe/erase/write/
    erase) y confirmar que el equipo vuelve a quedar vivo en el prompt '=>'."""
    if is_tross_step_completed("tross_uboot_flashed"):
        print("[=] Etapa 'tross_uboot_flashed' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 2/13: Interrumpir el arranque y flashear U-Boot del Tross ---")

    _print_yellow_banner(
        "Conecte un cable consola (TROSS) al puerto CONSOLE del TROSS y el "
        "otro extremo al puerto 17 del ZPE."
    )
    pedir("cable_tross", "Conecte el cable consola al puerto CONSOLE del Tross y al puerto 17 del ZPE. Presione Listo.")

    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"], take_control=True)
    try:
        # El ZPE vuelca el scrollback del ultimo boot al conectar (no es en
        # vivo), por eso se pide el reinicio fisico recien ahora.
        _print_yellow_banner(
            "Ya se establecio la conexion a la consola del Tross. Ahora reinicie "
            "FISICAMENTE el Tross de forma manual (apague y encienda, o presione "
            "el boton de reset) y presione ENTER en cuanto lo haya hecho."
        )
        pedir("reinicio_tross", "Reinicie FISICAMENTE el Tross (apague y encienda, o boton de reset) y presione Listo en cuanto lo haya hecho.")

        _uboot_break_spam(child)

        # --- tftpboot del uboot, con reintento completo del bloque si la
        # respuesta no coincide con lo esperado ---
        intentos_tftp = 0
        while True:
            intentos_tftp += 1
            if intentos_tftp > 5:
                print_ascii_fail("La descarga de U-Boot por tftp no dio la respuesta esperada tras 5 intentos.")
                raise RuntimeError("tftpboot de U-Boot fallo 5 veces seguidas (revisa DHCP/TFTP y la red del Tross).")
            _paced_sendline(
                child, f"setenv ipaddr {CFG['tross_ip']};setenv netmask {CFG['tross_netmask']};setenv gatewayip {CFG['tftp_server']}"
            )
            child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)
            _paced_sendline(child, f"setenv serverip {CFG['tftp_server']}")
            child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)

            print(f"[CMD U-Boot] tftpboot 0x60000000 {CFG['uboot_file']}")
            _paced_sendline(child, f"tftpboot 0x60000000 {CFG['uboot_file']}")
            idx = child.expect([r"Load address: 0x60000000", pexpect.TIMEOUT, pexpect.EOF], timeout=90)
            output = child.before or ""
            required = [
                "Change GMAC speed to 1000MB",
                "Using gmac-0@mdk device",
                f"TFTP from server {CFG['tftp_server']}",
                f"our IP address is {CFG['tross_ip']}",
                f"Filename '{CFG['uboot_file']}'",
            ]
            if idx == 0 and all(m in output for m in required):
                print("[✓] Respuesta de 'tftpboot' (paso1) validada correctamente.")
                child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)
                break
            print("[!] La respuesta de 'tftpboot' no cumplio lo esperado (paso1). Reintentando paso1...")

        _uboot_cmd_check(
            child, "sf probe",
            f"SF: Detected {CFG['uboot_flash']} with page size 256 Bytes, erase size 64 KiB, total 16 MiB"
        )
        _uboot_cmd_check(
            child, "sf erase 0x0 0x100000",
            "SF: 1048576 bytes @ 0x0 Erased: OK"
        )
        _uboot_cmd_check(
            child, "sf write 0x60000000 0x0 0x100000",
            "SF: 1048576 bytes @ 0x0 Written: OK"
        )
        _uboot_cmd_check(
            child, "sf erase 0x1c0000 0x10000",
            "SF: 65536 bytes @ 0x1c0000 Erased: OK"
        )

        print("[CMD U-Boot] reset")
        _paced_sendline(child, "reset")
        _uboot_break_spam(child)
        print("[✓] U-Boot flasheado; el Tross quedo esperando en el prompt '=>'.")
    finally:
        _zpe_console_exit(child)

    mark_tross_step_completed("tross_uboot_flashed")

def _tross_stage_boot_linux():
    """ETAPA 3/13: bootear Linux por red desde el '=>' de U-Boot, loguear y
    validar la version de kernel (uname -a)."""
    if is_tross_step_completed("tross_linux_booted"):
        print("[=] Etapa 'tross_linux_booted' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 3/13: Bootear Linux por red y validar el kernel ---")

    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"])
    try:
        _tross_ensure_logged_in(child)

        _paced_sendline(child, "killall rcS")
        child.expect([TROSS_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=30)

        _run_tross_cmd_and_wait(
            child, "uname -a", max_wait_seconds=30, poll_interval=5,
            label="Validando kernel del Tross"
        )
        uname_output = child.before or ""
        if CFG["kernel_version"] not in uname_output:
            print_ascii_fail("La version de kernel del Tross no coincide con la esperada (uname -a).")
            raise RuntimeError("Validacion de 'uname -a' fallo en el Tross.")
        print(f"[✓] Kernel del Tross validado ({CFG['kernel_version']}).")
    finally:
        _zpe_console_exit(child)

    mark_tross_step_completed("tross_linux_booted")

def _tross_stage_download_imageset():
    """ETAPA 4/13: descargar imageset.tgz por TFTP (con reintento ante
    mismatch de MAC o timeout transitorio de red) y validar 'ls' + 'md5sum'."""
    if is_tross_step_completed("tross_imageset_downloaded"):
        print("[=] Etapa 'tross_imageset_downloaded' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 4/13: Descargar y validar imageset.tgz por TFTP ---")

    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"])
    try:
        _tross_ensure_logged_in(child)

        _paced_sendline(child, "cd /tmp")
        child.expect([TROSS_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=20)

        MAC_MISMATCH_MARKERS = ("server write failed", "Network is unreachable")
        TRANSIENT_FAILURE_MARKERS = ("Retry limit exceeded", "server read timed out")

        while True:
            tftp_output = _run_tross_cmd_and_wait(
                child, f"tftp -g -r {CFG['imageset_file']} {CFG['tftp_server']}",
                max_wait_seconds=240, poll_interval=5,
                label="Descargando imageset.tgz por tftp"
            )
            is_mac_mismatch = any(m in tftp_output for m in MAC_MISMATCH_MARKERS)
            is_transient_failure = any(m in tftp_output for m in TRANSIENT_FAILURE_MARKERS)
            if is_mac_mismatch:
                _print_red_banner("La MAC del Tross no coincide con la del DHCP.")
                nueva = pedir("tross_mac_mal", "La MAC del Tross no coincide con la que tiene el DHCP. Escribe la MAC correcta (viene en la etiqueta del Tross) o deja vacio para reintentar igual:").strip()
                limpia = re.sub(r'[^0-9a-fA-F]', '', nueva)
                if len(limpia) == 12:
                    mac_ok = ":".join(limpia[i:i + 2] for i in range(0, 12, 2)).lower()
                    print(f"[*] Aplicando la MAC corregida {mac_ok} en el DHCP...")
                    _set_dhcp_host_mac("tross", mac_ok, CFG["tross_ip"])
                    run_interactive("sudo systemctl restart isc-dhcp-server")
                    run_interactive("sudo systemctl restart isc-dhcp-server6")
                    _update_state_config({"tross_mac": mac_ok})
                continue
            if is_transient_failure:
                # Timeout de red, no mismatch de MAC: probablemente
                # transitorio (se ha visto acompañado de un corte breve del
                # link durante la espera).
                _print_red_banner(
                    "La descarga de imageset.tgz por TFTP fallo por timeout "
                    "('Retry limit exceeded' / 'server read timed out'), no por "
                    "mismatch de MAC. Puede deberse a un corte momentaneo de red.\n"
                    "\n"
                    "Verifique la conectividad de red hacia 10.0.0.254 si el problema "
                    "persiste tras varios reintentos.\n"
                    "\n"
                    "Presione ENTER para reintentar la descarga."
                )
                pedir("reintentar", "La descarga de imageset.tgz por TFTP se corto por tiempo (no es la MAC). Revisa la red hacia el servidor TFTP y presiona Reintentar.")
                continue
            print("[✓] Descarga de imageset.tgz completada sin errores de red.")
            break

        if not _wait_for_pattern_with_enters(child, r"root@[^:\r\n]*:/tmp", max_seconds=240, interval=5,
                                              label="Esperando prompt '.../tmp'"):
            print_ascii_fail("No se recibio el prompt de shell en /tmp tras esperar 4 minutos.")
            raise RuntimeError("Timeout esperando el prompt de shell en /tmp del Tross.")

        ls_output = _run_tross_cmd_and_wait(child, "ls", max_wait_seconds=30, poll_interval=5,
                                             label="Listando /tmp")
        expected_files = ["StatsWB.Flow.lock", "StatsWB.Port.lock", "core", "imageset.tgz", "sandcastle"]
        if not all(f in ls_output for f in expected_files):
            print_ascii_fail("El listado de /tmp en el Tross no contiene los archivos esperados.")
            raise RuntimeError("Validacion de 'ls' fallo en el Tross.")
        print("[✓] Listado de /tmp validado correctamente.")

        md5_output = _run_tross_cmd_and_wait(
            child, "md5sum imageset.tgz", max_wait_seconds=45, poll_interval=5,
            label="Calculando md5sum de imageset.tgz"
        )
        if CFG["imageset_md5"] not in md5_output:
            print_ascii_fail("El md5sum de imageset.tgz no coincide con el esperado.")
            raise RuntimeError("Validacion de 'md5sum' fallo en el Tross.")
        print("[✓] md5sum de imageset.tgz validado correctamente.")
    finally:
        _zpe_console_exit(child)

    mark_tross_step_completed("tross_imageset_downloaded")

def _tross_stage_run_imager():
    """ETAPA 5/13: extraer e imagear el Tross (tar + imager, ~20 minutos) y
    validar el tail de la respuesta."""
    if is_tross_step_completed("tross_imager_done"):
        print("[=] Etapa 'tross_imager_done' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 5/13: Extraer e imagear el Tross (tar + imager, ~20 minutos) ---")

    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"])
    try:
        _tross_ensure_logged_in(child)
        _paced_sendline(child, "cd /tmp")
        child.expect([TROSS_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=20)

        imager_output = _run_tross_cmd_and_wait(
            child,
            "tar Oxzf imageset.tgz tools-cf.tgz | tar xz && netconfig=no ./imager ab",
            max_wait_seconds=1800, poll_interval=10,
            label="Ejecutando imager (aprox. 20 minutos)"
        )
        required_tail = [
            f"md5 of '/tmp/imageset.tgz' = {CFG['imager_md5']}",
            "sudo mount -a -t vfat",
            "Setting regionselect to a/0",
            "sync",
        ]
        if not all(s in imager_output for s in required_tail):
            print_ascii_fail(
                "La salida del comando 'imager' no contiene lo esperado. "
                "Se requiere atencion del operador."
            )
            raise RuntimeError("Validacion de la salida de 'imager' fallo en el Tross.")
        print("[✓] Imageo del Tross completado y validado correctamente.")
    finally:
        _zpe_console_exit(child)

    mark_tross_step_completed("tross_imager_done")

def _tross_stage_bootenv():
    """ETAPA 6/13: reiniciar el Tross, configurar bootcase_1/bootdelay,
    guardar el entorno (saveenv) y volver a loguear tras el reset final."""
    if is_tross_step_completed("tross_bootenv_saved"):
        print("[=] Etapa 'tross_bootenv_saved' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 6/13: Guardar bootcase_1/bootdelay y volver a loguear ---")

    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"])
    try:
        _tross_ensure_logged_in(child)

        print("[CMD Tross] reboot")
        _paced_sendline(child, "reboot")
        _uboot_break_spam(child)

        _paced_sendline(child, 'setenv bootcase_1 "bootcount 2;run pri_cf_bootcmd"')
        child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)
        _paced_sendline(child, "setenv bootdelay 3")
        child.expect([UBOOT_PROMPT, pexpect.TIMEOUT], timeout=20)

        _uboot_cmd_check(
            child, "saveenv",
            ["Saving Environment to SPI Flash...",
             f"SF: Detected {CFG['uboot_flash']} with page size 256 Bytes, erase size 64 KiB, total 16 MiB",
             "Erasing SPI flash...Writing to SPI flash...done"],
            timeout=45,
            fail_msg="La respuesta de 'saveenv' no es la esperada. Se requiere atencion del operador."
        )

        print("[CMD U-Boot] reset")
        _paced_sendline(child, "reset")
        # Espera en silencio: un ENTER durante la ventana 'Hit any key to
        # stop autoboot' que sigue al reset interrumpiria el autoboot.
        if not _wait_silently_for_pattern(child, r"login:", max_seconds=210, poll_interval=5,
                                           label="Esperando prompt 'login:' tras reset (sin enviar teclas)"):
            print_ascii_fail("No se recibio el prompt 'login:' del Tross tras 'reset'.")
            raise RuntimeError("Timeout esperando el prompt 'login:' del Tross tras 'reset'.")

        _tross_do_login(child)
    finally:
        _zpe_console_exit(child)

    mark_tross_step_completed("tross_bootenv_saved")

def _tross_stage_zpe_eth1():
    """ETAPA 7/13: reconfigurar ETH1 del ZPE via SSH (10.0.0.253 estatica)."""
    if is_tross_step_completed("tross_zpe_eth1_reconfigured"):
        print("[=] Etapa 'tross_zpe_eth1_reconfigured' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 7/13: Reconfigurar ETH1 del ZPE via SSH (10.0.0.253 estatica) ---")

    _tross_reconfigure_zpe_eth1()

    mark_tross_step_completed("tross_zpe_eth1_reconfigured")

def _tross_stage_lease(tross_mac):
    """ETAPA 8/13: reconectar la consola del Tross, detectar su 'lease' de
    red (a partir de las leases del ZPE) y validarlo con ping."""
    if is_tross_step_completed("tross_lease_detected"):
        print("[=] Etapa 'tross_lease_detected' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 8/13: Detectar el 'lease' de red del Tross y validarlo con ping ---")

    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"])
    try:
        _tross_ensure_logged_in(child)

        target_mac = _mac_plus_offset(tross_mac, CFG["mac_offset"])
        print(f"[*] Buscando el lease asociado a la MAC {target_mac} (tross_mac + {CFG['mac_offset']})...")

        # El lease puede tardar en aparecer si el Tross aun no renovo su
        # DHCP tras la reconfiguracion de ETH1 del ZPE.
        LEASE_WAIT_MAX_SECONDS = 180
        LEASE_WAIT_POLL_SECONDS = 15
        matches = []
        elapsed = 0
        while True:
            leases_output = _run_tross_cmd_and_wait(
                child, f"cat {CFG['leases_file']}",
                max_wait_seconds=45, poll_interval=5, label="Leyendo leases del ZPE"
            )
            blocks = re.findall(r"lease\s+([\d.]+)\s*\{(.*?)\n\}", leases_output, re.DOTALL)
            matches = [ip for ip, body in blocks if target_mac.lower() in body.lower()]
            if matches:
                break
            if elapsed >= LEASE_WAIT_MAX_SECONDS:
                break
            print(f"[=] Todavia no aparece un lease para {target_mac}; puede que el Tross aun no haya "
                  f"renovado su DHCP contra la red recien reconfigurada. Reintentando en "
                  f"{LEASE_WAIT_POLL_SECONDS}s (maximo {LEASE_WAIT_MAX_SECONDS}s)...")
            _green_wait(LEASE_WAIT_POLL_SECONDS, "Esperando a que aparezca el lease del Tross")
            elapsed += LEASE_WAIT_POLL_SECONDS

        if not matches:
            print_ascii_fail(f"No se encontro ningun lease asociado a la MAC {target_mac} en el ZPE.")
            raise RuntimeError("No se pudo determinar 'tross_lease' a partir de las leases del ZPE.")

        tross_lease = matches[-1]
        print(f"[+] tross_lease detectado: {tross_lease}")

        print(f"[*] Pingueando {tross_lease} desde la consola del Tross...")
        _paced_sendline(child, f"ping -c 3 {tross_lease}")
        idx = child.expect([r"64 bytes from", pexpect.TIMEOUT, pexpect.EOF], timeout=45)
        if idx != 0:
            print_ascii_fail(f"No se recibio respuesta de ping desde {tross_lease}.")
            raise RuntimeError("Validacion de 'ping' al tross_lease fallo.")
        child.expect([TROSS_PROMPT, pexpect.TIMEOUT, pexpect.EOF], timeout=20)
        print(f"[✓] Ping a {tross_lease} exitoso.")
    finally:
        _zpe_console_exit(child)

    mark_tross_step_completed("tross_lease_detected", {"tross_lease": tross_lease})

def _tross_stage_vrmu_flash(tross_lease):
    """ETAPA 9/13: flasheo del Tross via vrmu_util (comando repetido 2
    veces, con 10 minutos de espera forzosa entre corridas, ya que el
    flasheo sigue en curso en el Tross aunque el comando ya haya retornado)."""
    if is_tross_step_completed("tross_vrmu_flash_done"):
        print("[=] Etapa 'tross_vrmu_flash_done' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 9/13: Flasheo del Tross via vrmu_util (2 corridas, ~10 min c/u) ---")

    sudo_user = usuario()
    home_dir = home()
    flash_cmd = (
        f"cd {home_dir} && ./vrmu_util --api=/rmu_util --api=/macros/flash "
        f"--hostname={tross_lease} --srec_prefix={CFG['ledare_prefix']} --logtostderr "
        f"--envelope_enabled=false"
    )

    if not os.access(os.path.join(home_dir, "vrmu_util"), os.X_OK):
        print_ascii_fail("No esta ~/vrmu_util (o no se puede ejecutar).")
        raise RuntimeError("Falta ~/vrmu_util: corre primero el paso 'VRMU util'.")
    codigos = []
    for n in (1, 2):
        print(f"[*] Ejecutando vrmu_util (flash) - intento {n}/2...")
        salida, codigo = _run_local_cmd_with_wait(
            flash_cmd, max_wait_seconds=900, poll_interval=10,
            label=f"vrmu_util flash (intento {n}/2)"
        )
        codigos.append(codigo)
        if codigo != 0:
            print(f"[AVISO] vrmu_util (flash) regreso codigo {codigo} en el intento {n}/2. Revisa la salida de arriba.")
        if n == 1:
            _green_wait(CFG["espera_flash_min"] * 60,
                        f"Esperando los {CFG['espera_flash_min']} minutos obligatorios antes de repetir el flash")
    if all(c != 0 for c in codigos):
        print_ascii_fail("vrmu_util (flash) fallo en los 2 intentos.")
        raise RuntimeError(f"vrmu_util flash fallo en los 2 intentos (codigos {codigos}).")

    mark_tross_step_completed("tross_vrmu_flash_done")

def _tross_stage_vrmu_upgrade(tross_lease):
    """ETAPA 10/13: actualizacion de firmware periferico via vrmu_util."""
    if is_tross_step_completed("tross_vrmu_upgrade_done"):
        print("[=] Etapa 'tross_vrmu_upgrade_done' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 10/13: Actualizacion de firmware periferico via vrmu_util ---")

    sudo_user = usuario()
    home_dir = home()
    upgrade_cmd = (
        f"cd {home_dir} && ./vrmu_util --envelope_enabled=false --hostname={tross_lease} "
        f"--logtostderr --api=/api/peripheral/upgrade "
        f"--peripheral_firmware_filename={CFG['fw_container']}"
    )
    print("[*] Ejecutando vrmu_util (peripheral upgrade)...")
    upgrade_output, _ = _run_local_cmd_with_wait(
        upgrade_cmd, max_wait_seconds=900, poll_interval=10,
        label="vrmu_util peripheral upgrade"
    )

    if "INTERNAL: Upgrade failed: 1" in upgrade_output:
        print_ascii_fail("La actualizacion de firmware periferico del Tross fallo (Upgrade failed: 1).")
        raise RuntimeError("vrmu_util peripheral upgrade reporto 'Upgrade failed: 1'.")
    elif "INTERNAL: Upgrade failed: 2" in upgrade_output:
        print("[✓] vrmu_util peripheral upgrade completado (respuesta esperada: 'Upgrade failed: 2').")
    else:
        print_ascii_fail(
            "La respuesta de vrmu_util (peripheral upgrade) no coincide con ninguno de los "
            "resultados esperados. Se requiere atencion del operador."
        )
        raise RuntimeError("Respuesta inesperada de vrmu_util en 'peripheral upgrade'.")

    mark_tross_step_completed("tross_vrmu_upgrade_done")


def _tross_stage_vrmu_fw_version_check(tross_lease):
    """ETAPA 11/13: verifica, via vrmu_util, que la version de firmware del
    Ledare (bloque 'streamz_name: "/flash/fw-version"') haya quedado en la
    version objetivo (por defecto 'Ledare 1.8.5'). Reintenta con espera, ya
    que el cambio de firmware puede seguir aplicandose en segundo plano
    despues de que el comando de upgrade (etapa 10) haya retornado."""
    if is_tross_step_completed("tross_vrmu_fw_version_checked"):
        print("[=] Etapa 'tross_vrmu_fw_version_checked' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 11/13: Verificar version de firmware (fw-version) ---")

    sudo_user = usuario()
    home_dir = home()
    fw_version_cmd = (
        f"cd {home_dir} && ./vrmu_util --hostname={tross_lease} --envelope_enabled=false "
        f"| grep -a4 fw-version"
    )
    expected_version_string = f"Ledare {CFG['ledare_version']}"
    flash_block_pattern = re.compile(
        r'streamz_name:\s*"/flash/fw-version".*?string_value:\s*"([^"]*)"', re.DOTALL
    )

    FW_VERSION_MAX_WAIT_SECONDS = 300
    FW_VERSION_POLL_SECONDS = 30
    elapsed = 0
    fw_output = ""
    current_version = None
    while True:
        print("[*] Ejecutando vrmu_util para verificar fw-version...")
        fw_output, _ = _run_local_cmd_with_wait(
            fw_version_cmd, max_wait_seconds=120, poll_interval=5,
            label="Verificando fw-version"
        )

        match = flash_block_pattern.search(fw_output)
        current_version = match.group(1) if match else None

        if current_version == expected_version_string:
            print(f'[✓] Version de firmware del Ledare validada correctamente '
                  f'(string_value: "{expected_version_string}").')
            mark_tross_step_completed("tross_vrmu_fw_version_checked")
            return

        if elapsed >= FW_VERSION_MAX_WAIT_SECONDS:
            break

        if current_version:
            print(f"[=] La version de firmware del Ledare todavia es \"{current_version}\" "
                  f"(se espera \"{expected_version_string}\"); el Tross puede seguir aplicando "
                  f"el cambio en segundo plano. Reintentando en {FW_VERSION_POLL_SECONDS}s "
                  f"(maximo {FW_VERSION_MAX_WAIT_SECONDS}s)...")
        else:
            print(f"[!] No se encontro el bloque 'streamz_name: \"/flash/fw-version\"' en la "
                  f"salida. Reintentando en {FW_VERSION_POLL_SECONDS}s "
                  f"(maximo {FW_VERSION_MAX_WAIT_SECONDS}s)...")
        _green_wait(FW_VERSION_POLL_SECONDS, "Esperando a que el Tross termine de aplicar el firmware")
        elapsed += FW_VERSION_POLL_SECONDS

    if current_version:
        print_ascii_fail(
            f'La version de firmware del Ledare quedo en "{current_version}" (se esperaba '
            f'"{expected_version_string}") tras esperar varios minutos despues del upgrade. '
            f"Se requiere atencion del operador."
        )
        raise RuntimeError(
            f'Validacion de fw-version fallo: version actual "{current_version}", '
            f'esperada "{expected_version_string}".'
        )
    else:
        print_ascii_fail(
            "No se pudo encontrar el bloque 'streamz_name: \"/flash/fw-version\"' en la "
            "salida de vrmu_util tras varios intentos."
        )
        raise RuntimeError("No se pudo determinar la version de firmware del Ledare (fw-version).")

def _parse_rectifier_voltages(dc_voltage_output):
    """Extrae pares (device_name, voltage) de cada bloque
    'streamz_name: "/rectifier/dc-voltage"'. El valor relevante es el
    'float_value' con 'units: "volts"' dentro de ese bloque, no el campo de
    "amps" que el contexto de grep arrastra del bloque anterior."""
    pattern = re.compile(
        r'streamz_name:\s*"/rectifier/dc-voltage".*?device_name:\s*"([^"]*)".*?'
        r'units:\s*"volts".*?float_value:\s*([\-0-9.]+)',
        re.DOTALL
    )
    return [(m.group(1), float(m.group(2))) for m in pattern.finditer(dc_voltage_output)]

def _ping_until_up(ip, description, max_wait_seconds=300, poll_interval=10):
    """Hace ping a 'ip' repetidamente hasta obtener respuesta o agotar
    'max_wait_seconds'. Devuelve True/False segun si respondio a tiempo."""
    print(f"[*] Esperando a que {description} ({ip}) responda ping...")
    elapsed = 0
    while True:
        result = subprocess.run(
            f"ping -c 1 -W 2 {ip}", shell=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        if result.returncode == 0:
            print(f"[✓] {description} ({ip}) respondio ping.")
            return True
        if elapsed >= max_wait_seconds:
            return False
        _green_wait(poll_interval, f"Esperando ping de {description} ({ip})")
        elapsed += poll_interval

def _tross_validate_instruments_after_power_cycle():
    """Tras un power-cycle del rack completo, confirma que la cadena de
    equipos volvio a arrancar en orden: Juniper (10.0.0.254), ZPE
    (10.0.0.253) -- la consola del Tross se accede a traves de el -- y por
    ultimo el propio Tross via telnet. Corta con una falla clara si alguno
    no responde a tiempo."""
    print("--- Validando instrumentos tras el power-cycle del rack (Juniper -> ZPE -> Tross) ---")

    if not _ping_until_up(CFG["tftp_server"], "Juniper", max_wait_seconds=300, poll_interval=10):
        print_ascii_fail(f"El Juniper ({CFG['tftp_server']}) no respondio ping tras el power-cycle del rack.")
        raise RuntimeError(f"Validacion de instrumentos fallo: Juniper ({CFG['tftp_server']}) sin ping.")

    if not _ping_until_up(CFG["zpe_ip"], "ZPE", max_wait_seconds=300, poll_interval=10):
        print_ascii_fail(f"El ZPE ({CFG['zpe_ip']}) no respondio ping tras el power-cycle del rack.")
        raise RuntimeError(f"Validacion de instrumentos fallo: ZPE ({CFG['zpe_ip']}) sin ping.")

    print("[*] Validando que el Tross haya terminado de bootear (via telnet a traves del ZPE)...")
    child = _open_zpe_console_telnet(CFG["zpe_puerto_tross"])
    try:
        _tross_ensure_logged_in(child)
        print("[✓] El Tross boot\u00f3 correctamente y esta accesible via consola.")
    finally:
        _zpe_console_exit(child)

    _green_wait(600, "Esperando 10 minutos tras validar el booteo del Tross (estabilizacion)")

    print("[✓] Validacion de instrumentos completa: Juniper, ZPE y Tross arriba.")

def _measure_rectifier_voltages_with_retry(tross_lease, max_retries=3, retry_wait_seconds=300):
    """Mide el voltaje DC de los rectificadores via vrmu_util. Reintenta
    hasta 'max_retries' veces (con 'retry_wait_seconds' de espera entre
    intentos) si la conexion falla o si todas las lecturas dan 0 -- comun
    justo despues de un power-cycle, mientras el servicio de telemetria del
    Tross todavia esta levantando.

    Si se agotan los reintentos sin lecturas utiles, pregunta al operador
    (y/n) si quiere borrar engine_flags_tross.json y reiniciar la configuracion
    desde cero; en cualquier caso, termina el programa con una falla."""
    sudo_user = usuario()
    home_dir = home()
    dc_voltage_cmd = (
        f"cd {home_dir} && ./vrmu_util --hostname={tross_lease} --envelope_enabled=false "
        f"| grep -a4 dc-voltage"
    )

    for intento in range(1, max_retries + 1):
        print(f"[*] Ejecutando vrmu_util para medir el voltaje DC de los rectificadores "
              f"(intento {intento}/{max_retries})...")
        dc_output, _ = _run_local_cmd_with_wait(
            dc_voltage_cmd, max_wait_seconds=60, poll_interval=5,
            label="Verificando dc-voltage"
        )
        readings = _parse_rectifier_voltages(dc_output)
        all_zero = bool(readings) and all(voltage == 0 for _, voltage in readings)

        if readings and not all_zero:
            return readings

        if not readings:
            print(f"[!] No se encontro ninguna lectura de dc-voltage (intento {intento}/{max_retries}). "
                  f"Puede que el servicio de telemetria del Tross todavia este levantando.")
        else:
            print(f"[!] Todas las lecturas de dc-voltage dieron 0 (intento {intento}/{max_retries}).")

        if intento < max_retries:
            _green_wait(retry_wait_seconds,
                        f"Esperando antes del reintento {intento + 1}/{max_retries}")

    _print_red_banner(
        f"No se pudieron obtener lecturas validas de dc-voltage tras {max_retries} intentos "
        f"(con {retry_wait_seconds // 60} minutos de espera entre cada uno).\n"
        "\n"
        "Se recomienda reiniciar la configuracion completa del Tross desde cero."
    )
    respuesta = pedir("si_no",
        "No se pudieron obtener lecturas validas de dc-voltage tras varios intentos. "
        f"¿Borrar el estado del Tross ({os.path.basename(TROSS_STATE_FILE)}) y empezar de nuevo desde la etapa 1?"
    ).strip().lower()

    if respuesta in ("y", "si", "s", "yes"):
        print(f"[*] Borrando {TROSS_STATE_FILE} (y su respaldo) para empezar de cero...")
        for path in (TROSS_STATE_FILE, TROSS_STATE_FILE + ".bak"):
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception as e:
                print(f"[!] Advertencia: no se pudo borrar '{path}' automaticamente ({e}). "
                      f"Borralo manualmente antes de reintentar.")
        raise RuntimeError(
            "No se obtuvieron lecturas validas de dc-voltage tras varios reintentos. Se borro "
            "el estado del Tross (engine_flags_tross.json); hay que iniciar la configuracion del "
            "Tross de nuevo desde cero."
        )

    raise RuntimeError(
        "No se obtuvieron lecturas validas de dc-voltage tras varios reintentos. El estado del "
        "Tross se dejo intacto; se puede volver a correr el script para reintentar sin perder "
        "el progreso ya hecho."
    )

def _tross_stage_voltage_check(tross_lease):
    """ETAPA 12/13: valida que todos los rectificadores del Tross lean por
    encima de 50V DC (streamz '/rectifier/dc-voltage'). La medicion en si
    reintenta ante fallas de conexion o lecturas en 0 (ver
    _measure_rectifier_voltages_with_retry).

    Como la unica recuperacion ante un voltaje genuinamente bajo es un
    power-cycle del rack completo -- que mataria a este mismo proceso --
    la etapa funciona en dos fases:

    Fase 1: si algun rectificador lee <=50V, guarda la bandera
    'tross_voltage_check_awaiting_power_cycle', pide al operador un power
    cycle del rack completo, y termina el programa (sys.exit(0)).

    Fase 2 (proxima corrida, con esa bandera activa): valida primero que
    Juniper, ZPE y Tross hayan vuelto a arrancar
    (_tross_validate_instruments_after_power_cycle) y vuelve a medir. Si
    ahora todos leen >50V, la etapa se completa. Si no, se considera una
    falla irrecuperable: borra engine_flags_tross.json y termina con error."""
    if is_tross_step_completed("tross_voltage_check_done"):
        print("[=] Etapa 'tross_voltage_check_done' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 12/13: Validar voltaje DC de los rectificadores (dc-voltage) ---")

    awaiting_power_cycle = is_tross_step_completed("tross_voltage_check_awaiting_power_cycle")
    if awaiting_power_cycle:
        # Ya se habia pedido el power-cycle del rack completo en una corrida
        # anterior de esta misma etapa. Antes de repetir la medicion de
        # voltaje, hay que confirmar que toda la cadena de equipos volvio a
        # arrancar correctamente.
        _tross_validate_instruments_after_power_cycle()

    readings = _measure_rectifier_voltages_with_retry(tross_lease, max_retries=3, retry_wait_seconds=300)

    print("[*] Lecturas de voltaje DC por rectificador:")
    for device_name, voltage in readings:
        marker = "✓" if voltage > CFG["voltaje_min"] else "✗"
        print(f"    [{marker}] {device_name}: {voltage} V")

    all_ok = all(voltage > CFG["voltaje_min"] for _, voltage in readings)

    if all_ok:
        print(f"[✓] Todos los rectificadores miden un voltaje DC > {CFG['voltaje_min']}V.")
        mark_tross_step_completed("tross_voltage_check_done")
        return

    if not awaiting_power_cycle:
        # --- FASE 1: primera vez que vemos un voltaje bajo ---
        mark_tross_step_completed("tross_voltage_check_awaiting_power_cycle")
        _print_yellow_banner(
            "Se detectaron rectificadores con voltaje DC <= 50V (se esperaba > 50V en TODOS).\n"
            "\n"
            "Por favor realice un POWER CYCLE DEL RACK COMPLETO (apague y encienda todo el "
            "rack, no solo el Tross).\n"
            "\n"
            "Una vez que el rack haya terminado de volver a encender, vuelva a correr "
            "gf_provisioning.py: esta validacion de voltaje se repetira automaticamente."
        )
        print("[*] Terminando el programa de forma segura antes del power-cycle del rack...")
        raise _Pausa("Hay rectificadores con voltaje bajo. Haz un POWER CYCLE DEL RACK COMPLETO y, cuando "
                     "vuelva a encender, corre otra vez el Tross: esta etapa se repite sola.")

    # --- FASE 2: ya se habia pedido un power-cycle antes, y el voltaje SIGUE bajo ---
    print_ascii_fail(
        "El voltaje DC de los rectificadores sigue <= 50V incluso despues del power-cycle "
        "del rack. Se considera que la configuracion del Tross fallo de forma irrecuperable; "
        "hay que rehacerla desde cero."
    )
    print(f"[*] Borrando {TROSS_STATE_FILE} (y su respaldo) para forzar rehacer todo el "
          f"proceso del Tross desde cero en el proximo intento...")
    for path in (TROSS_STATE_FILE, TROSS_STATE_FILE + ".bak"):
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            print(f"[!] Advertencia: no se pudo borrar '{path}' automaticamente ({e}). "
                  f"Borralo manualmente antes de reintentar.")
    raise RuntimeError(
        "Validacion de voltaje DC fallo tras el power-cycle del rack. Se borro el estado del "
        "Tross (engine_flags_tross.json); hay que iniciar la configuracion del Tross de nuevo desde cero."
    )

def _tross_stage_voltage_sequence_test(tross_lease):
    """ETAPA 13/13: prueba funcional de los rectificadores. Baja el voltaje
    de salida a 45V durante 15 segundos:

        vrmu_util --api="/api/rectifier/outputsequence"
                   --rectifier_output_sequence="45:100:15"

    (se puede observar el LED de los Jolt100 cambiar de >50V a <50V) y
    confirma, releyendo dc-voltage, que los rectificadores efectivamente
    respondieron: se espera que ahora lean entre 40V y 50V (ni sigan en los
    ~55V de operacion normal -- lo que indicaria que no reaccionaron -- ni
    caigan a 0/sin lectura)."""
    if is_tross_step_completed("tross_voltage_sequence_tested"):
        print("[=] Etapa 'tross_voltage_sequence_tested' ya fue ejecutada previamente. Omitiendo...")
        return
    print("--- ETAPA 13/13: Prueba de secuencia de voltaje (45V/15s) en los rectificadores ---")

    sudo_user = usuario()
    home_dir = home()
    sequence_cmd = (
        f'cd {home_dir} && ./vrmu_util --hostname={tross_lease} --envelope_enabled=false '
        f'--api="/api/rectifier/outputsequence" --rectifier_output_sequence="{CFG["secuencia_voltaje"]}" 2>&1'
    )
    dc_voltage_cmd = (
        f"cd {home_dir} && ./vrmu_util --hostname={tross_lease} --envelope_enabled=false "
        f"| grep -a4 dc-voltage"
    )

    print("[*] Enviando secuencia de voltaje (45V durante 15s) a los rectificadores...")
    _run_local_cmd_with_wait(
        sequence_cmd, max_wait_seconds=60, poll_interval=5,
        label="Ejecutando outputsequence (45V/15s)"
    )

    print("[*] Verificando que el voltaje DC haya caido al rango esperado (>40V y <50V)...")
    time.sleep(1)

    # En campo se confirmo que la caida de voltaje es breve (aprox. 2-6s,
    # no los 15s que sugiere el nombre del parametro) y que los 23
    # rectificadores no caen ni se recuperan de forma simultanea. Una sola
    # lectura puntual puede caer justo antes de que arranque el dip o
    # cuando algunos ya se estan recuperando. Por eso se sondea varias
    # veces durante la ventana activa y se evalua cada rectificador por su
    # lectura minima observada, no por una coincidencia simultanea entre
    # los 23.
    poll_window_seconds = 8
    poll_interval_seconds = 1
    min_voltage_by_device = {}
    elapsed = 0
    while True:
        dc_output, _ = _run_local_cmd_with_wait(
            dc_voltage_cmd, max_wait_seconds=60, poll_interval=5,
            label=f"Verificando dc-voltage (t={elapsed}s de {poll_window_seconds}s)"
        )
        readings = _parse_rectifier_voltages(dc_output)
        for device_name, voltage in readings:
            previous = min_voltage_by_device.get(device_name)
            if previous is None or voltage < previous:
                min_voltage_by_device[device_name] = voltage
        if elapsed >= poll_window_seconds:
            break
        time.sleep(poll_interval_seconds)
        elapsed += poll_interval_seconds

    if not min_voltage_by_device:
        print_ascii_fail(
            "No se encontro ninguna lectura de dc-voltage tras la secuencia de prueba."
        )
        raise RuntimeError(
            "No se pudieron obtener lecturas de dc-voltage tras la secuencia de voltaje."
        )

    print("[*] Lectura minima de voltaje DC observada por rectificador durante la ventana:")
    for device_name, voltage in min_voltage_by_device.items():
        marker = "✓" if CFG["secuencia_min"] < voltage < CFG["secuencia_max"] else "✗"
        print(f"    [{marker}] {device_name}: {voltage} V")

    all_in_range = all(CFG["secuencia_min"] < voltage < CFG["secuencia_max"] for voltage in min_voltage_by_device.values())
    if not all_in_range:
        print_ascii_fail(
            "No todos los rectificadores cayeron al rango esperado (>40V y <50V) tras la "
            "secuencia de prueba. Se requiere atencion del operador."
        )
        raise RuntimeError("La prueba de secuencia de voltaje (45V/15s) fallo.")

    print("[✓] Todos los rectificadores respondieron correctamente a la secuencia de voltaje "
          "(quedaron entre 40V y 50V).")
    mark_tross_step_completed("tross_voltage_sequence_tested")

def download_python_tools():
    if is_step_completed("download_python_tools"):
        print("[=] Paso 'download_python_tools' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO: Descarga de Herramientas Python por SCP ---")
    
    remote_host = CFG["tools_host"]
    sudo_user = usuario()
    remote_user = sudo_user
    
    files_to_download = lista_cfg("tools_files")

    destination_dir = home()   # al home (Liberar rack busca ~/reboot.py)
    
    for filename in files_to_download:
        remote_path = f"{remote_user}@{remote_host}:/home/{remote_user}/{filename}"
        cmd = f"scp -r {remote_path} {destination_dir}/"

        def _download_once(filename=filename, cmd=cmd):
            print(f"[*] Descargando {filename} por SCP...")
            print(f"[CMD Interactive] {cmd}")

            child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=None)

            class PexpectLogger:
                def write(self, text):
                    sys.stdout.write(text)
                    sys.stdout.flush()
                def flush(self):
                    sys.stdout.flush()

            child.logfile_read = PexpectLogger()

            while True:
                idx = child.expect([
                    r"Are you sure you want to continue connecting",
                    r"[pP]assword:",
                    pexpect.EOF
                ], timeout=600)

                if idx == 0:
                    print("\n[*] Detectado prompt de huella SSH. Enviando 'yes'...")
                    child.sendline("yes")
                elif idx == 1:
                    print("\n[*] Ingresando contraseña para SCP...")
                    child.sendline(SUDO_PASSWORD)
                elif idx == 2:
                    break

            child.close()

            if child.exitstatus != 0:
                raise RuntimeError(f"Error descargando {filename} por SCP (Exit code: {child.exitstatus})")

        try:
            _retry_download(_download_once, f"descarga de {filename} por SCP")
        except RuntimeError:
            print_ascii_fail(f"No se pudo descargar {filename} por SCP tras varios intentos.")
            raise

    print("[✓] Todas las herramientas fueron descargadas exitosamente.")
    mark_step_completed("download_python_tools")

def fix_chrome():
    if is_step_completed("fix_chrome"):
        print("[=] Paso 'fix_chrome' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO: Eliminación y Reinstalación Limpia de Google Chrome ---")

    print("[*] Eliminando y purgando Google Chrome...")
    run_interactive("sudo apt-get purge google-chrome-stable -y")
    run_interactive("sudo apt-get autoremove -y")
    run_interactive("sudo apt-get clean -y")

    print("[*] Limpiando archivos de configuración residuales y llaves GPG antiguas...")
    run_command("sudo rm -f /etc/apt/trusted.gpg.d/google-chrome.gpg", check=False)
    run_command("sudo rm -f /etc/apt/sources.list.d/google-chrome.list", check=False)
    # (con sudo, '~' seria el home de root: se borran las del usuario)
    run_command(f"rm -rf {home()}/.config/google-chrome", check=False)
    run_command(f"rm -rf {home()}/.cache/google-chrome", check=False)

    print("[*] Descargando e instalando nuevamente la llave GPG oficial de Google...")
    _retry_download(lambda: run_interactive(GPG_KEY_IMPORT_CMD), "descarga de llave GPG de Google")

    print("[*] Configurando el repositorio oficial de Google Chrome...")
    repo_cmd = f'echo "deb [arch=amd64] {CFG["chrome_repo"]} stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list'
    run_interactive(repo_cmd)

    print("[*] Actualizando listas de paquetes de apt e instalando Google Chrome Stable...")
    apt_install(["google-chrome-stable"])

    print("[✓] Google Chrome ha sido eliminado y reinstalado exitosamente.")
    mark_step_completed("fix_chrome")

def _flush_log_to_disk():
    """Fuerza flush + fsync del archivo de log a disco SIN cerrarlo, para no
    romper los print() posteriores (sys.stdout/sys.stderr siguen redirigidos
    al DualLogger). A diferencia de log_final_summary()/logger_instance.close(),
    esta funcion es segura de llamar en medio de la ejecucion."""
    if logger_instance is None:
        return
    try:
        logger_instance.logfile.flush()
        os.fsync(logger_instance.logfile.fileno())
    except Exception as e:
        print(f"[!] Advertencia: no se pudo forzar el fsync del log ({e}).")

def _force_reboot():
    """Fuerza el reinicio del sistema de forma robusta, con multiples
    fallbacks. Como el equipo puede empezar a apagarse a mitad de la
    ejecucion (dejando la sesion/pipe inestable), NINGUNA excepcion de un
    intento detiene el flujo: se pasa directamente al siguiente metodo.
    Solo se lanza RuntimeError si absolutamente todos los intentos fallan."""

    # --- Intento 1: reboot interactivo via pexpect (maneja prompt de sudo) ---
    reboot_cmd = "sudo reboot"
    print(f"[CMD Interactive] {reboot_cmd}")
    try:
        child = pexpect.spawn("bash", ["-c", reboot_cmd], encoding="utf-8", timeout=30)
        child.logfile_read = sys.stdout
        idx = child.expect([
            r"\[sudo\] password for .*:?",
            r"[pP]assword:",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=30)
        if idx in (0, 1):
            child.sendline(SUDO_PASSWORD)
            child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=30)
        child.close(force=True)
        print("[✓] Comando de reinicio enviado correctamente (pexpect).")
        return
    except Exception as e:
        print(f"[!] El reinicio via pexpect fallo o la sesion se volvio inestable: {e}")

    # --- Intento 2: fallback directo por subprocess con password pipeada ---
    print("[*] Reintentando el reinicio via fallback (subprocess + sudo -S)...")
    try:
        sh_run("sudo reboot", timeout=30)
        print("[✓] Comando de reinicio enviado correctamente (fallback subprocess).")
        return
    except Exception as e:
        print(f"[!] El fallback por subprocess tambien fallo: {e}")

    # --- Intento 3: ultimo recurso, reboot forzado (reboot -f) ---
    print("[*] Ultimo recurso: forzando el reinicio con 'reboot -f'...")
    try:
        sh_run("sudo reboot -f", timeout=30)
        print("[✓] Comando de reinicio forzado enviado correctamente ('reboot -f').")
        return
    except Exception as e:
        print_ascii_fail()
        raise RuntimeError(f"No se pudo forzar el reinicio del sistema por ningun metodo: {e}")
def end_config_reboot():
    if is_step_completed("end_config_reboot"):
        print("[=] Paso 'end_config_reboot' ya fue ejecutado previamente. Omitiendo...")
        return

    GREEN = "\033[92m"
    RESET = "\033[0m"

    state = load_state()
    flags = state.get("flags", {})
    completed_steps = [k for k, v in flags.items() if v]
    pendientes = [n for n, _, _, g, _, _ in PASOS if g == "server" and n != "end_config_reboot" and not flags.get(n)]

    print(f"\n{GREEN}{'='*60}")
    print("           CONFIGURACION TERMINADA EXITOSAMENTE           ")
    print(f"{'='*60}{RESET}")
    print(f"{GREEN}[+] Pasos completados ({len(completed_steps)}):{RESET}")
    for step in completed_steps:
        print(f"{GREEN}    - {step}{RESET}")
    if pendientes:
        print("[AVISO] Pasos del servidor sin palomita: " + ", ".join(pendientes))
    print(f"{GREEN}{'='*60}\n{RESET}")

    mark_step_completed("end_config_reboot")

    # Reinicio recomendado: si nadie contesta en 'reinicio_min' minutos, se reinicia solo
    minutos = max(1, CFG["reinicio_min"])
    respuesta = pedir(
        "reinicio",
        f"Configuracion del servidor terminada. Se recomienda reiniciar. "
        f"¿Reiniciar ahora? (si/no). Si nadie contesta, se reinicia solo en {minutos} min.",
        segundos=minutos * 60, defecto="si"
    ).strip().lower()

    if respuesta not in ("si", "s", "yes", "y", ""):
        print("\n[*] Se omitio el reboot recomendado. Continuando sin reiniciar...")
        return

    print("\n[*] Forzando el flush del log a disco (sin cerrarlo) antes del reboot...")
    _flush_log_to_disk()
    print("[*] Forzando el reinicio del sistema...")
    _force_reboot()
    print("[*] Cerrando el log de ejecucion...")
    log_final_summary()


# ==============================================================================
# PASOS (en orden) · (nombre, funcion, contrasenas, grupo, archivo de banderas, siempre)
#   archivo "main"  -> engine_flags.json
#   archivo "tross" -> engine_flags_tross.json (borrarlo = rehacer el Tross desde cero)
#   siempre=True    -> se corre aunque ya tenga palomita
# ==============================================================================
def _tross_mac():
    mac = load_state().get("config", {}).get("tross_mac")
    if not mac:
        raise RuntimeError("No se encontro 'tross_mac'. Corre primero el paso 'MAC del Tross'.")
    return mac

def _tross_lease():
    lease = load_tross_state().get("config", {}).get("tross_lease")
    if not lease:
        raise RuntimeError("No se encontro 'tross_lease'. Corre primero la etapa 'Lease de red del Tross'.")
    return lease

PASOS = [
    # ---- Servidor ----
    ("set_ID", set_ID, (), "server", "main", False),
    ("set_network", set_network, ("sudo",), "server", "main", False),
    ("gitconfig_cookie", gitconfig_cookie, ("mirror",), "server", "main", False),
    ("flex_tag", flex_tag, ("sudo",), "server", "main", False),
    ("run_security_patch", run_security_patch, ("sudo",), "server", "main", False),
    ("validate_and_lego_setup", validate_and_lego_setup, ("sudo",), "server", "main", False),
    ("setup_nomachine_yaml", setup_nomachine_yaml, (), "server", "main", False),
    ("ensure_dhcp", ensure_dhcp, ("sudo",), "server", "main", False),
    ("run_ansible_playbook", run_ansible_playbook, ("sudo", "vault"), "server", "main", False),
    ("provisional_dhcp", provisional_dhcp, ("sudo",), "server", "main", False),
    ("network_plan", network_plan, ("sudo",), "server", "main", False),
    ("force_test_network_selection", force_test_network_selection, ("sudo",), "server", "main", True),
    ("reinstall_goss", reinstall_goss, ("sudo",), "server", "main", False),
    ("run_final_abmx_config", run_final_abmx_config, ("sudo", "vault", "mirror"), "server", "main", False),
    ("create_networkmanager_symlink", create_networkmanager_symlink, ("sudo",), "server", "main", False),
    ("download_python_tools", download_python_tools, ("sudo",), "server", "main", False),
    ("fix_chrome", fix_chrome, ("sudo",), "server", "main", False),
    ("end_config_reboot", end_config_reboot, ("sudo",), "server", "main", False),
    # ---- Juniper y ZPE ----
    ("juniper_config", juniper_config, ("sudo",), "equipos", "main", False),
    ("zpe_config", zpe_config, ("sudo",), "equipos", "main", False),
    # ---- Tross ----
    ("vrmu_util_config", vrmu_util_config, ("sudo",), "tross", "main", False),
    ("tross_capture_mac", tross_capture_mac, ("sudo",), "tross", "main", False),
    ("tross_dhcp_applied", lambda: _tross_stage_dhcp(_tross_mac()), ("sudo",), "tross", "tross", False),
    ("tross_uboot_flashed", _tross_stage_flash_uboot, (), "tross", "tross", False),
    ("tross_linux_booted", _tross_stage_boot_linux, (), "tross", "tross", False),
    ("tross_imageset_downloaded", _tross_stage_download_imageset, ("sudo",), "tross", "tross", False),
    ("tross_imager_done", _tross_stage_run_imager, (), "tross", "tross", False),
    ("tross_bootenv_saved", _tross_stage_bootenv, (), "tross", "tross", False),
    ("tross_zpe_eth1_reconfigured", _tross_stage_zpe_eth1, (), "tross", "tross", False),
    ("tross_lease_detected", lambda: _tross_stage_lease(_tross_mac()), (), "tross", "tross", False),
    ("tross_vrmu_flash_done", lambda: _tross_stage_vrmu_flash(_tross_lease()), (), "tross", "tross", False),
    ("tross_vrmu_upgrade_done", lambda: _tross_stage_vrmu_upgrade(_tross_lease()), (), "tross", "tross", False),
    ("tross_vrmu_fw_version_checked", lambda: _tross_stage_vrmu_fw_version_check(_tross_lease()), (), "tross", "tross", False),
    ("tross_voltage_check_done", lambda: _tross_stage_voltage_check(_tross_lease()), (), "tross", "tross", False),
    ("tross_voltage_sequence_tested", lambda: _tross_stage_voltage_sequence_test(_tross_lease()), (), "tross", "tross", False),
]
GRUPOS = ("server", "equipos", "tross")
SIN_PEXPECT = ("set_ID", "set_network", "setup_nomachine_yaml")

def hecho(nombre, archivo):
    return is_tross_step_completed(nombre) if archivo == "tross" else is_step_completed(nombre)

def desmarcar(nombre, archivo):
    st = load_tross_state() if archivo == "tross" else load_state()
    if st.get("flags", {}).pop(nombre, None) is not None:
        (save_tross_state if archivo == "tross" else save_state)(st)

def correr_paso(nombre, fn, passes, grupo, archivo, siempre):
    if hecho(nombre, archivo) and not siempre:
        aviso(paso=nombre, estado="omitido")
        print(f"[=] Paso '{nombre}' ya fue ejecutado previamente. Omitiendo...")
        return
    aviso(paso=nombre, estado="inicio")
    t0 = time.time()
    try:
        if not pexpect and nombre not in SIN_PEXPECT:
            raise RuntimeError("Falta el modulo pexpect de Python. Corre el paso 'Red SFC y paquetes base' del servidor, "
                               "que lo instala, o a mano: sudo apt install python3-pexpect")
        requiere(*passes)
        if "sudo" in passes:
            _activate_sudo()
        while True:
            try:
                fn()
                break
            except _ZpeConsoleReadOnlyError as e:   # consola del ZPE trabada: se reinicia el ZPE y se repite la etapa
                print(f"[!] {e}")
                _print_red_banner("La consola del ZPE quedo en modo solo-lectura y no se pudo recuperar sola.")
                pedir("reiniciar_zpe", "La consola del ZPE se quedo en solo lectura. Apaga y enciende el ZPE y presiona Listo cuando haya encendido.")
                _green_wait(60, "Esperando a que el ZPE termine de levantar")
                print("[*] Reintentando la etapa...")
    except _Pausa as e:
        aviso(paso=nombre, estado="pausa", error=str(e)[:600], seg=round(time.time() - t0, 1))
        print(f"\n[⏸] {e}")
        raise
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            aviso(paso=nombre, estado="fallo", error="Detenido por el usuario")
            raise
        msg = str(e) or e.__class__.__name__
        if isinstance(e, SystemExit):
            msg = f"El paso termino el script (codigo {e.code})"
        aviso(paso=nombre, estado="fallo", error=msg[:600], seg=round(time.time() - t0, 1))
        print(f"\n[✕] Fallo el paso '{nombre}': {msg}")
        sys.exit(1)
    if hecho(nombre, archivo):
        aviso(paso=nombre, estado="ok", seg=round(time.time() - t0, 1))
    else:
        aviso(paso=nombre, estado="fallo", error="El paso termino sin marcarse como hecho.", seg=round(time.time() - t0, 1))
        sys.exit(1)

def principal():
    ap = argparse.ArgumentParser(description="Config Engine · aprovisionamiento Ghostfish (Connection Validation)")
    ap.add_argument("--grupo", choices=GRUPOS, help="Corre los pasos pendientes de: server, equipos o tross")
    ap.add_argument("--paso", help="Corre solo este paso (le quita la palomita antes)")
    ap.add_argument("--estado", action="store_true", help="Imprime en JSON las palomitas")
    ap.add_argument("--lista", action="store_true", help="Imprime los pasos en JSON")
    ap.add_argument("--valores", action="store_true", help="Imprime los valores de fabrica en JSON")
    args = ap.parse_args()

    if args.lista:
        print(json.dumps([{"id": n, "grupo": g, "archivo": a, "pass": list(p), "siempre": s} for n, _, p, g, a, s in PASOS]))
        return
    if args.valores:
        print(json.dumps(CFG_DEFECTO, ensure_ascii=False)); return
    if args.estado:
        print(json.dumps({"flags": {n: bool(hecho(n, a)) for n, _, _, _, a, _ in PASOS},
                          "config": {k: v for k, v in load_state().get("config", {}).items() if k != "_credentials"},
                          "tross": load_tross_state().get("config", {})}, ensure_ascii=False))
        return
    if not args.paso and not args.grupo:
        ap.error("indica --grupo server|equipos|tross o --paso NOMBRE")

    activar_log()
    if SUDO_PASSWORD:
        print("[*] Activando sudo de forma automatica...")
        print("[✓] Sudo activado correctamente." if _activate_sudo() else "[!] No se pudo confirmar la activacion inicial de sudo.")

    try:
        if args.paso:
            paso = next((x for x in PASOS if x[0] == args.paso), None)
            if not paso:
                print(f"[✕] No existe el paso '{args.paso}'. Pasos: {', '.join(x[0] for x in PASOS)}"); sys.exit(2)
            desmarcar(paso[0], paso[4])   # se quita la palomita para correrlo de nuevo
            correr_paso(*paso)
            aviso(fin="paso", paso=paso[0])
            return
        for paso in PASOS:
            if paso[3] == args.grupo:
                correr_paso(*paso)
        aviso(fin="grupo", grupo=args.grupo)
    except _Pausa:
        aviso(fin="pausa")
        sys.exit(0)

if __name__ == "__main__":
    principal()
