#!/usr/bin/env python3
import json
import os
import sys
import subprocess
import re
try:
    import pexpect
except ImportError:   # --estado/--lista funcionan sin pexpect; los pasos que lo usan avisan qué instalar
    class _SinPexpect:
        def __getattr__(self, nombre):
            raise RuntimeError("pexpect no esta instalado: corre 'sudo apt install python3-pexpect' y vuelve a intentar.")
        def __bool__(self):
            return False
    pexpect = _SinPexpect()
import time
import select
import atexit
import uuid
import getpass
import argparse

# ==============================================================================
# CONNECTION VALIDATION (app) · versión parchada e integrada
#   - Valores (IPs, repos, interfaces…) en un archivo JSON: GF_CONFIG=/ruta/valores.json
#   - Contraseñas por variables de entorno (no van escritas en el código):
#       GF_SUDO_PASS, GF_VAULT_PASS, GF_MIRROR_PASS, GF_JUNIPER_PASS, GF_ZPE_PASS
#     Si se corre a mano en una terminal y falta alguna, se pide con getpass.
#   - Con GF_APP=1 el script avisa a la app con líneas "@@GF {json}" y le pide
#     respuestas (rack, cables, reinicio) por la entrada estándar.
#   - Opciones:  --paso NOMBRE   corre solo ese paso (aunque ya esté hecho)
#                --estado        imprime en JSON qué pasos están hechos
#                --tross-mac MAC pone la MAC del Tross en el DHCP y lo reinicia
# ==============================================================================
CFG_DEFECTO = {
    "state_file": "provisioning_state.json",
    "red_base": "172.24.125.",            # IP del servidor = red_base + (rack + suma_rack)
    "suma_rack": 99,
    "gateway": "172.24.125.1",
    "dns": "8.8.8.8",
    "iface_sfc": "eno1",
    "hostname_prefijo": "ghostfish-ist-flg-",
    "mirror_ip": "172.24.125.2",
    "mirror_user": "testusr",
    "repo_security": "https://mfg-partners.googlesource.com/security-hardened-image",
    "repo_lego": "https://mfg-partners.googlesource.com/lego-infra",
    "crowdstrike_tag": "Flex_Guadalajara_PROD",
    "nomachine_url": "https://download.nomachine.com/download/9.8/Linux/nomachine_9.8.2_1_amd64.deb",
    "iface_test": "ens4f0",
    "iface_test2": "ens4f1",
    "juniper_version": "20.2R2.11",
    "zpe_ip": "10.0.0.253",
    "zpe_user": "admin",
    "tross_ip": "10.0.0.251",
    "vrmu_host": "172.24.125.172",
    "tools_host": "172.24.125.174"
}
CFG = dict(CFG_DEFECTO)
try:
    if os.environ.get("GF_CONFIG") and os.path.exists(os.environ["GF_CONFIG"]):
        with open(os.environ["GF_CONFIG"], encoding="utf-8") as _f:
            CFG.update({k: v for k, v in json.load(_f).items() if k in CFG_DEFECTO and v not in (None, "")})
except Exception as _e:
    print(f"[!] No se pudo leer GF_CONFIG ({_e}); se usan los valores de fábrica.")
CFG["suma_rack"] = int(CFG["suma_rack"])

EN_APP = os.environ.get("GF_APP") == "1"

def aviso(**datos):
    """Línea para la app: @@GF {json}. En terminal no estorba (se ve como una línea más)."""
    try:
        sys.stdout.write("\n@@GF " + json.dumps(datos, ensure_ascii=False) + "\n")   # en su propia línea
        sys.stdout.flush()
    except Exception:
        pass

def pedir(tipo, mensaje, **extra):
    """Pide algo al operador. Con la app: aviso + respuesta por stdin. En terminal: input()."""
    if EN_APP:
        aviso(pide=tipo, msg=mensaje, **extra)
        r = sys.stdin.readline()
        if r == "":
            raise RuntimeError(f"La app no respondió a la pregunta '{tipo}'.")
        return r.rstrip("\r\n")
    return input(mensaje + " ")

def usuario():
    """Usuario dueño del home donde se trabaja (antes se asumía 'testusr')."""
    u = os.environ.get("SUDO_USER")
    if u:
        return u
    try:
        return getpass.getuser()
    except Exception:
        return "testusr"

# ==============================================================================
# CONFIGURACIÓN DE LOGGING Y TIEMPO TRASCURRIDO
# ==============================================================================
START_TIME = time.time()
LOG_FILE_PATH = f"provisioning_execution_{time.strftime('%Y%m%d_%H%M%S')}.log"

class DualLogger:
    """Duplica la salida estándar (stdout) y de error (stderr) hacia la terminal y un archivo de log."""
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
            os.fsync(self.logfile.fileno())  # Fuerza la escritura física en disco
            self.logfile.close()

# Redireccionamos stdout y stderr desde el inicio
logger_instance = None

def activar_log():
    """Duplica la salida a provisioning_execution_*.log (solo cuando se corren pasos, no con --estado)."""
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
    summary = (
        f"\n======================================================================\n"
        f" [LOG CLOSED] Fecha: {timestamp}\n"
        f" [LOG CLOSED] Tiempo total transcurrido: {time_str}\n"
        f"======================================================================\n"
    )
    print(summary)
    if logger_instance is not None:
        logger_instance.close()

# (atexit se registra en activar_log, solo si se corren pasos)

# ==============================================================================
# VARIABLES GLOBALES
# ==============================================================================
STATE_FILE = CFG["state_file"]
# Contraseñas: llegan por variables de entorno (la app las pide cada vez y no las guarda)
SUDO_PASSWORD = os.environ.get("GF_SUDO_PASS", "")
VAULT_PASSWORD = os.environ.get("GF_VAULT_PASS", "")
MIRROR_PASSWORD = os.environ.get("GF_MIRROR_PASS", "")
JUNIPER_ROOT_PASSWORD = os.environ.get("GF_JUNIPER_PASS", "")
ZPE_PASSWORD = os.environ.get("GF_ZPE_PASS", "")
DEFAULT_NOMACHINE_URL = CFG["nomachine_url"]

_NOMBRES_PASS = {"sudo": ("GF_SUDO_PASS", "SUDO_PASSWORD"), "vault": ("GF_VAULT_PASS", "VAULT_PASSWORD"),
                 "mirror": ("GF_MIRROR_PASS", "MIRROR_PASSWORD"), "juniper": ("GF_JUNIPER_PASS", "JUNIPER_ROOT_PASSWORD"),
                 "zpe": ("GF_ZPE_PASS", "ZPE_PASSWORD")}

def requiere(*cuales):
    """Revisa que estén las contraseñas que necesita un paso. En terminal las pide; con la app, falla claro."""
    for c in cuales:
        env, var = _NOMBRES_PASS[c]
        if globals().get(var):
            continue
        if not EN_APP and sys.stdin.isatty():
            globals()[var] = getpass.getpass(f"Contraseña {c}: ")
            continue
        raise RuntimeError(f"Falta la contraseña de {c} ({env}).")

DHCPD_CONF_CONTENT = """# BEGIN ANSIBLE MANAGED BLOCK
ddns-update-style none;
ignore client-updates;
allow booting;
allow bootp;
ddns-updates off;
default-lease-time 6000;
max-lease-time 7200;
authoritative;
subnet 10.0.0.0 netmask 255.255.0.0 {
  option subnet-mask 255.255.0.0;
  option routers 10.0.0.254;
  option broadcast-address 10.0.255.255;
  next-server 10.0.0.254;

  filename "http://10.0.0.254:8001/pxelinux.0";
}
host izumi-1 { hardware ethernet 98:98:FB:CA:F0:E5; fixed-address 10.0.0.1; }
host izumi-2 { hardware ethernet 98:98:FB:CA:F1:85; fixed-address 10.0.0.2; }
host izumi-3 { hardware ethernet 98:98:FB:CB:06:DD; fixed-address 10.0.0.3; }
host izumi-4 { hardware ethernet 98:98:FB:CB:01:ED; fixed-address 10.0.0.4; }
host izumi-5 { hardware ethernet 98:98:FB:CA:D6:D5; fixed-address 10.0.0.5; }
host izumi-6 { hardware ethernet 98:98:FB:D0:DA:05; fixed-address 10.0.0.6; }
host izumi-7 { hardware ethernet 98:98:FB:CB:06:E5; fixed-address 10.0.0.7; }
host izumi-8 { hardware ethernet 98:98:FB:C5:98:8D; fixed-address 10.0.0.8; }
host izumi-9 { hardware ethernet 98:98:FB:CF:26:55; fixed-address 10.0.0.9; }
host izumi-10 { hardware ethernet 98:98:FB:CB:0D:85; fixed-address 10.0.0.10; }
host izumi-11 { hardware ethernet 98:98:FB:CF:25:3D; fixed-address 10.0.0.11; }
host izumi-12 { hardware ethernet 98:98:FB:CA:E6:05; fixed-address 10.0.0.12; }
host izumi-13 { hardware ethernet 98:98:FB:CB:6E:95; fixed-address 10.0.0.13; }
host izumi-14 { hardware ethernet 98:98:FB:D0:E7:25; fixed-address 10.0.0.14; }
host izumi-15 { hardware ethernet 98:98:FB:CA:E5:F5; fixed-address 10.0.0.15; }
host izumi-16 { hardware ethernet 98:98:FB:C5:33:3D; fixed-address 10.0.0.16; }
host rj45-switch { hardware ethernet 00:00:00:00:00:00; fixed-address 10.0.0.249; }

# END ANSIBLE MANAGED BLOCK
host zpe { hardware ethernet e4:1a:2c:02:c3:0c; fixed-address 10.0.0.253; }
host iboot { hardware ethernet 00:0D:AD:04:92:28; fixed-address 10.0.0.250; }
host tross { hardware ethernet C0:1C:6A:66:C2:E4; fixed-address 10.0.0.251; }
  filename "http://10.0.0.254:8001/pxelinux.0";"""

DHCPD6_CONF_CONTENT = """# BEGIN ANSIBLE MANAGED BLOCK
ddns-update-style none;
ignore client-updates;
allow booting;
allow bootp;
ddns-updates off;
default-lease-time 6000;
max-lease-time 7200;
authoritative;
option domain-search-list code 119 = text;
option dhcp6.bootfile-url code 59 = string;
option dhcp6.name-servers fd00::9;

subnet6 fd00::/64 {
range6 fd00::11 fd00::FF;
option dhcp6.bootfile-url "http://[fd00::9]:8001/diorite/ipxe.cfg";
log(info, "DHCPv6 - Found other ipv6 client...");

host diorite-1 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CA:F0:E2;
log(info, "DHCPv6 - Found Diorite-1 client...");
fixed-address6 fd00::10;
}
host diorite-2 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CA:F1:82;
log(info, "DHCPv6 - Found Diorite-2 client...");
fixed-address6 fd00::11;
}
host diorite-3 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CB:06:DA;
log(info, "DHCPv6 - Found Diorite-3 client...");
fixed-address6 fd00::12;
}
host diorite-4 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CB:01:EA;
log(info, "DHCPv6 - Found Diorite-4 client...");
fixed-address6 fd00::13;
}
host diorite-5 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CA:D6:D2;
log(info, "DHCPv6 - Found Diorite-5 client...");
fixed-address6 fd00::14;
}
host diorite-6 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:D0:DA:02;
log(info, "DHCPv6 - Found Diorite-6 client...");
fixed-address6 fd00::15;
}
host diorite-7 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CB:06:E2;
log(info, "DHCPv6 - Found Diorite-7 client...");
fixed-address6 fd00::16;
}
host diorite-8 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:C5:98:8A;
log(info, "DHCPv6 - Found Diorite-8 client...");
fixed-address6 fd00::17;
}
host diorite-9 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CF:26:52;
log(info, "DHCPv6 - Found Diorite-9 client...");
fixed-address6 fd00::18;
}
host diorite-10 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CB:0D:82;
log(info, "DHCPv6 - Found Diorite-10 client...");
fixed-address6 fd00::19;
}
host diorite-11 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CF:25:3A;
log(info, "DHCPv6 - Found Diorite-11 client...");
fixed-address6 fd00::1A;
}
host diorite-12 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CA:E6:02;
log(info, "DHCPv6 - Found Diorite-12 client...");
fixed-address6 fd00::1B;
}
host diorite-13 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CB:6E:92;
log(info, "DHCPv6 - Found Diorite-13 client...");
fixed-address6 fd00::1C;
}
host diorite-14 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:D0:E7:22;
log(info, "DHCPv6 - Found Diorite-14 client...");
fixed-address6 fd00::1D;
}
host diorite-15 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:CA:E5:F2;
log(info, "DHCPv6 - Found Diorite-15 client...");
fixed-address6 fd00::1E;
}
host diorite-16 {
host-identifier option dhcp6.client-id  00:03:00:01:98:98:FB:C5:33:3A;
log(info, "DHCPv6 - Found Diorite-16 client...");
fixed-address6 fd00::1F;
}
}
# END ANSIBLE MANAGED BLOCK"""

def print_ascii_fail():
    red_code = "\033[91m\033[1m"
    reset_code = "\033[0m"
    banner = r"""
================================================================================

  FFFFFFFFFFFFFFFFFFFFFF     AAA               IIIIIIIIII LLLLLLLLL             
  F::::::::::::::::::::F    A:::A              I::::::::I L::::::::L            
  F::::::::::::::::::::F   A:::::A             I::::::::I L::::::::L            
  FF::::::FFFFFFFFF:::F  A:::::::A            II::::::II LL:::::::LL            
    F:::::F       FFFFFF A:::::A:::::A            I::::I     L::::L             
    F:::::F             A:::::A A:::::A           I::::I     L::::L             
    F::::::FFFFFFFFFF  A:::::A   A:::::A          I::::I     L::::L             
    F:::::::::::::::F A:::::A     A:::::A         I::::I     L::::L             
    F::::::FFFFFFFFFF A:::::AAAAAAAAA:::::A        I::::I     L::::L             
    F:::::F          A::::::::::::::::::::A       I::::I     L::::L             
    F:::::F         A:::::AAAAAAAAAAAAA:::::A      I::::I     L::::L             
    F:::::F        A:::::A             A:::::A     I::::I     L::::L      FFFFFF 
  FF:::::::FF     A:::::A               A:::::A  II::::::II LL:::::::LLLLLL::::L 
  F::::::::F     A:::::A                 A:::::A I::::::::I L::::::::::::::::::L 
  F::::::::F    A:::::A                   A:::::AI::::::::I L::::::::::::::::::L 
  FFFFFFFFFF   AAAAAAA                     AAAAAAAIIIIIIIIIILLLLLLLLLLLLLLLLLLLL 

================================================================================
    """
    print(f"{red_code}{banner}{reset_code}")
    print(f"{red_code}[!] ATENCION OPERADOR: Ansible reporto tareas FALLIDAS (failed > 0).{reset_code}")
    print(f"{red_code}[!] Por favor, revisa el log superior para hacer debug.{reset_code}\n")

def fix_state_file_permissions():
    if os.geteuid() != 0:
        return   # corriendo como usuario normal el archivo ya es suyo (y sudo sin terminal fallaría)
    if os.path.exists(STATE_FILE):
        sudo_user = usuario()
        subprocess.run(f"sudo chown {sudo_user}:{sudo_user} {STATE_FILE}", shell=True, stderr=subprocess.DEVNULL)

def load_state():
    fix_state_file_permissions()
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"flags": {}, "config": {}}

def save_state(state):
    fix_state_file_permissions()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=4)

def is_step_completed(step_name):
    state = load_state()
    return state.get("flags", {}).get(step_name, False)

def mark_step_completed(step_name, extra_config=None):
    state = load_state()
    state["flags"][step_name] = True
    if extra_config:
        state["config"].update(extra_config)
    save_state(state)
    print(f"[✓] Paso '{step_name}' completado y registrado en {STATE_FILE}.")

def _activate_sudo():
    """Activa (o refresca) las credenciales de sudo en cache de forma NO
    interactiva, usando SUDO_PASSWORD via 'sudo -S -v'. Se llama solo en
    puntos puntuales del flujo (inicio del programa, tras el ansible local,
    y tras salir del mirror), no de forma continua."""
    if not SUDO_PASSWORD:
        return False
    try:
        res = subprocess.run(
            f'echo "{SUDO_PASSWORD}" | sudo -S -v',
            shell=True,
            capture_output=True,
            text=True,
            timeout=15
        )
        if res.returncode != 0:
            print(f"[!] Advertencia: no se pudo activar/refrescar sudo automaticamente "
                  f"({res.stderr.strip()}).")
        return res.returncode == 0
    except Exception as e:
        print(f"[!] Advertencia: excepcion al activar/refrescar sudo automaticamente ({e}).")
        return False

def run_command(cmd, check=True):
    print(f"[CMD] {cmd}")
    res = subprocess.run(cmd, shell=True)
    if check and res.returncode != 0:
        raise RuntimeError(f"Error ejecutando comando: {cmd}")
    return res.returncode

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

def set_ID():
    if is_step_completed("set_ID"):
        print("[=] Paso 'set_ID' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 1: Configuracion de ID de Rack ---")
    # El rack llega de la app (GF_RACK); si no, se pregunta
    rack_num_str = (os.environ.get("GF_RACK") or pedir("rack", "Ingresa el numero de rack (ej. 90 o 54):")).strip()

    if not rack_num_str.isdigit():
        raise ValueError("El numero de rack debe ser un valor numerico.")

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

    requiere("sudo")
    # Si ya existe una conexión "SFC" (corrida anterior), se borra para no duplicarla
    existe = subprocess.run(["nmcli", "-t", "-f", "NAME", "connection", "show"], capture_output=True, text=True)
    if "SFC" in (existe.stdout or "").splitlines():
        print("[=] Ya existe la conexion 'SFC'. Se recrea con la IP de este rack...")
        run_interactive('sudo nmcli con delete "SFC"')
    nmcli_cmd = (
        f'sudo nmcli con add con-name "SFC" ifname {CFG["iface_sfc"]} type ethernet '
        f'ipv4.method manual ipv4.addresses {ip_address}/24 gw4 {CFG["gateway"]} ipv4.dns {CFG["dns"]}'
    )
    run_interactive(nmcli_cmd)

    print("[*] Verificando e importando llaves GPG faltantes para apt...")
    run_interactive(
        "wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/google-chrome.gpg"
    )

    run_interactive("sudo apt update")
    run_interactive("sudo apt-get update")

    pkgs_cmd = "sudo apt install openssh-server net-tools git sssd sssd-tools libpam-sss libnss-sss python3-pip -y"
    run_interactive(pkgs_cmd)

    print("[*] Instalando dependencias iniciales de pip3...")
    run_interactive("sudo pip3 install colorlog jsonpickle google.cloud --upgrade")

    sudo_user = usuario()
    user_home = f"/home/{sudo_user}"
    ssh_key_path = os.path.join(user_home, ".ssh/id_rsa")
    
    if not os.path.exists(ssh_key_path):
        print("[*] Generando llaves SSH (ssh-keygen)...")
        cmd = f"ssh-keygen -t rsa -N \"\" -f {ssh_key_path}"
        run_command(cmd)
        print("[✓] Llaves SSH generadas exitosamente.")
    else:
        print(f"[=] La llave SSH ya existe en {ssh_key_path}. Omitiendo ssh-keygen...")

    mark_step_completed("set_network")

def run_scp_from_mirror(remote_path, local_destination):
    requiere("mirror")
    mirror_ip = CFG["mirror_ip"]
    mirror_pass = MIRROR_PASSWORD
    cmd = f"scp {CFG['mirror_user']}@{mirror_ip}:{remote_path} {local_destination}"
    print(f"[CMD] Copiando desde Mirror: {cmd}")

    child = pexpect.spawn(cmd, encoding="utf-8", timeout=120)
    
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
            child.sendline(mirror_pass)
        elif idx == 2:
            break
        elif idx == 3:
            child.close()
            raise RuntimeError(f"Timeout copiando {remote_path} desde el Git Mirror.")

    child.close()
    if child.exitstatus != 0:
        raise RuntimeError(f"Error transfiriendo {remote_path} desde el Git Mirror.")

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
    user_home = f"/home/{sudo_user}"

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
    user_home = f"/home/{sudo_user}"
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
    apt_key_cmd = "sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys 32EE5355A6BC6E42"
    run_interactive(apt_key_cmd)

    mark_step_completed("flex_tag")

def run_security_patch():
    if is_step_completed("run_security_patch"):
        print("[=] Paso 'run_security_patch' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 5: Ejecución de setup-patch.sh ---")
    sudo_user = usuario()
    user_home = f"/home/{sudo_user}"
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
    user_home = f"/home/{sudo_user}"
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
    yaml_path = f"/home/{sudo_user}/lego-infra/lego_setup/lego_abmx_test_server/install-nomachine.yaml"

    if not os.path.exists(yaml_path):
        raise FileNotFoundError(f"No se encontró el archivo: {yaml_path}")

    state = load_state()
    nomachine_url = DEFAULT_NOMACHINE_URL   # siempre el valor actual (se cambia en Valores de la app)

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

def run_ansible_playbook():
    if is_step_completed("run_ansible_playbook"):
        print("[=] Paso 'run_ansible_playbook' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 8: Ejecucion de Ansible Playbook ---")
    state = load_state()
    hostname = state.get("config", {}).get("hostname")

    if not hostname:
        raise RuntimeError("No se encontro el hostname en la configuracion. Asegurate de correr 'set_ID' primero.")

    requiere("sudo", "vault")
    pip_upgrade_cmd = 'sudo python3.10 -m pip install --upgrade pip'
    downgrade_cmd = 'sudo python3.10 -m pip install "setuptools<70.0.0"'

    print("[*] Actualizando pip a la ultima version...")
    run_interactive(pip_upgrade_cmd)

    print("[*] Aplicando downgrade de setuptools PRE-Ansible...")
    run_interactive(downgrade_cmd)

    sudo_user = usuario()
    playbook_dir = f"/home/{sudo_user}/lego-infra/lego_setup/lego_abmx_test_server"

    cmd = (
        f"cd {playbook_dir} && "
        f"ansible-playbook -i localhost, lego_abmx_test_server_setup.yml -vv "
        f"--ask-become-pass --connection=local --vault-id @prompt --flush-cache"
    )

    print(f"[CMD Interactive] {cmd}")
    child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=3 * 3600)
    
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
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=3 * 3600)

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
        elif idx == 13:
            child.close(force=True)
            print_ascii_fail()
            raise RuntimeError("Ansible no terminó en 3 horas (se quedó esperando algo). Revisa la consola.")

    child.close()

    print("[*] Reactivando sudo de forma automatica tras el comando de ansible...")
    _activate_sudo()

    failed_match = re.search(r"failed=(\d+)", output_buffer)
    if failed_match:
        failed_count = int(failed_match.group(1))
        if failed_count > 0:
            print_ascii_fail()
            raise RuntimeError(f"Ansible Playbook finalizo con {failed_count} tarea(s) fallida(s).")

    if child.exitstatus != 0:
        print_ascii_fail()
        raise RuntimeError(f"Error en ejecucion de ansible-playbook (Exit code: {child.exitstatus})")

    print("[*] Aplicando downgrade de setuptools POST-Ansible...")
    run_interactive(downgrade_cmd)
    
    mark_step_completed("run_ansible_playbook")
    print("[*] Esperando 15 segundos antes de finalizar el paso...")
    time.sleep(15)

def provisional_dhcp():
    if is_step_completed("provisional_dhcp"):
        print("[=] Paso 'provisional_dhcp' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO 9: Configuracion de Archivos DHCP Provisionales ---")

    for destino, contenido in (("/etc/dhcp/dhcpd.conf", DHCPD_CONF_CONTENT), ("/etc/dhcp/dhcpd6.conf", DHCPD6_CONF_CONTENT)):
        print(f"[*] Creando {destino}...")
        tmp = f"/tmp/gf_{os.path.basename(destino)}"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(contenido + "\n")
        run_interactive(f"sudo install -m 644 {tmp} {destino}")
        os.remove(tmp)

    print("[*] Reiniciando servicios DHCP (IPv4 e IPv6)...")
    run_interactive("sudo systemctl restart isc-dhcp-server")
    run_interactive("sudo systemctl restart isc-dhcp-server6")

    print("[✓] Archivos DHCP creados y servicios reiniciados exitosamente en /etc/dhcp/.")
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
    run_command("rm -f ./goss ./goss-linux-* ./goss.tar.gz", check=False)

    print("[*] Instalando Goss de forma automatizada...")
    goss_install_cmd = "curl -fsSL https://goss.rocks/install | sudo sh"
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

    requiere("sudo", "vault", "mirror")
    print(f"[*] Corrigiendo ownership de /home/{sudo_user}/.local...")
    fix_local_dir_cmd = f"sudo chown -R {sudo_user}:{sudo_user} /home/{sudo_user}/.local"
    run_interactive(fix_local_dir_cmd)

    mirror_ip = CFG["mirror_ip"]
    mirror_pass = MIRROR_PASSWORD
    rx_pass_mirror = re.escape(f"{sudo_user}@{mirror_ip}") + r"'s password:"

    ssh_copy_cmd = f"ssh-copy-id -i ~/.ssh/id_rsa.pub {sudo_user}@{ip_address}"
    cmd_remote_copy = f"ssh {sudo_user}@{mirror_ip} '{ssh_copy_cmd}'"
    print(f"[CMD Interactive] {cmd_remote_copy}")

    child_copy = pexpect.spawn("bash", ["-c", cmd_remote_copy], encoding="utf-8", timeout=300)
    child_copy.logfile_read = sys.stdout

    while True:
        idx = child_copy.expect([
            r"Are you sure you want to continue connecting \(yes/no/\[fingerprint\]\)\?",
            rx_pass_mirror,
            r"[pP]assword:",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=120)

        if idx == 0:
            child_copy.sendline("yes")
        elif idx in (1, 2):
            child_copy.sendline(mirror_pass)
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

    child_ansible = pexpect.spawn("bash", ["-c", cmd_remote_ansible], encoding="utf-8", timeout=3 * 3600)
    salida_mirror = []
    class _Tee:
        def write(self, t):
            sys.stdout.write(t); salida_mirror.append(t)
            if len(salida_mirror) > 4000: del salida_mirror[:2000]
        def flush(self):
            sys.stdout.flush()
    child_ansible.logfile_read = _Tee()

    play_recap_detected = False

    while True:
        idx = child_ansible.expect([
            r"Are you sure you want to continue connecting \(yes/no/\[fingerprint\]\)\?",
            rx_pass_mirror,
            r"SSH password:",
            r"BECOME password\[defaults to SSH password\]:",
            r"BECOME password:",
            r"Vault password \(default\):",
            r"Please enter the password for '\S+' \(operator\)",
            r"\[sudo\] password for \S+:",
            r"PLAY RECAP",
            pexpect.EOF,
            pexpect.TIMEOUT
        ], timeout=3 * 3600)

        if idx == 0:
            child_ansible.sendline("yes")
        elif idx == 1:
            child_ansible.sendline(mirror_pass)
        elif idx in (2, 3, 4, 6, 7):
            child_ansible.sendline(SUDO_PASSWORD)
        elif idx == 5:
            child_ansible.sendline(VAULT_PASSWORD)
        elif idx == 8:
            play_recap_detected = True
            child_ansible.sendline("exit")
        elif idx == 9:
            break
        elif idx == 10:
            child_ansible.close(force=True)
            print_ascii_fail()
            raise RuntimeError("El ansible del mirror no terminó en 3 horas.")

    child_ansible.close()

    print("[*] Reactivando sudo de forma automatica tras salir del mirror...")
    _activate_sudo()

    if not play_recap_detected or child_ansible.exitstatus not in (0, None):
        print_ascii_fail()
        raise RuntimeError(f"Error en ejecucion de ansible-playbook via git-mirror (Exit code: {child_ansible.exitstatus})")
    fallidas = [int(x) for x in re.findall(r"failed=(\d+)", "".join(salida_mirror))]
    if any(fallidas):
        print_ascii_fail()
        raise RuntimeError(f"El ansible del mirror terminó con {max(fallidas)} tarea(s) fallida(s). Busca 'fatal:' en la consola.")

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
    apt_cmd = "sudo apt update && sudo apt install -y libsss-sudo gnome-control-center"
    run_interactive(apt_cmd)

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

    if0, if1 = CFG["iface_test"], CFG["iface_test2"]
    try:
        path_f0 = f'/sys/class/net/{if0}/address'
        path_f1 = f'/sys/class/net/{if1}/address'
        
        if os.path.exists(path_f0):
            with open(path_f0, 'r') as f:
                mac_f0 = f.read().strip().lower()
        if os.path.exists(path_f1):
            with open(path_f1, 'r') as f:
                mac_f1 = f.read().strip().lower()
    except Exception as e:
        print(f"[!] Warning leyendo sysfs: {e}")

    if not mac_f0 or not mac_f1:
        # Plan B: "ip -o link" (también encuentra ens4f0np0 / ens4f1np1 antes de renombrarlas)
        salida = subprocess.run(["ip", "-o", "link"], capture_output=True, text=True).stdout or ""
        def mac_de(nombre):
            m = re.search(r'^\d+:\s+' + re.escape(nombre) + r'(?:np\d+)?[:@].*?link/ether\s+([0-9a-fA-F:]{17})', salida, re.MULTILINE)
            return m.group(1).lower() if m else None
        mac_f0 = mac_f0 or mac_de(if0)
        mac_f1 = mac_f1 or mac_de(if1)

    if not mac_f0 or not mac_f1:
        print_ascii_fail()
        raise RuntimeError(f"No se pudieron obtener las direcciones MAC ({if0}: {mac_f0}, {if1}: {mac_f1})")

    print(f"[+] MAC {if0}: {mac_f0}")
    print(f"[+] MAC {if1}: {mac_f1}")

    state = load_state()
    if "interfaces" not in state:
        state["interfaces"] = {}

    state["interfaces"][if0] = mac_f0
    state["interfaces"][if1] = mac_f1
    save_state(state)

    netplan_content = f"""# Let NetworkManager manage all devices on this system
network:
  version: 2
  ethernets:
      {if0}np0:
               dhcp4: no
               match:
                   macaddress: {mac_f0}
               set-name: {if0}
      {if1}np1:
               dhcp4: no
               match:
                   macaddress: {mac_f1}
               set-name: {if1}
  renderer: NetworkManager
"""

    netplan_path = "/etc/netplan/01-network-manager-all.yaml"
    temp_netplan = "/tmp/01-network-manager-all.yaml"

    print(f"[*] Actualizando {netplan_path}...")
    with open(temp_netplan, "w") as f:
        f.write(netplan_content)

    run_interactive(f"sudo mv {temp_netplan} {netplan_path}")
    run_interactive(f"sudo chmod 600 {netplan_path}")

    print("[*] Aplicando Netplan...")
    run_interactive("sudo netplan try --timeout 5")
    run_interactive("sudo netplan apply")

    mark_step_completed("network_plan")

def force_test_network_selection():
    """Fuerza que la conexion 'Test Network' quede activa y priorizada en la interfaz ens4f0."""
    if is_step_completed("force_test_network_selection"):
        print("[=] Paso 'force_test_network_selection' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO: Forzar seleccion de 'Test Network' en Ethernet (ens4f0) ---")

    interface = CFG["iface_test"]
    target_conn = "Test Network"

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

    requiere("sudo", "juniper")
    print("--- PASO: Configuracion Automatica del Juniper via Consola Serial ---")

    mensaje = (
        "Conecte cable consola al puerto CON del Juniper (Por la parte de atras) "
        "y el otro extremo a un puerto USB 3.0 del Superlogics/ABMX."
    )

    # --- PASO A: Confirmar el cable de consola y abrir minicom ---
    child, used_device = _wait_for_console_connection_enter(mensaje, ["/dev/ttyUSB0", "/dev/ttyUSB1"], 9600, "cable_juniper")
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
        child.sendline(JUNIPER_ROOT_PASSWORD)
        _juniper_expect_or_fail(child, [r"[Rr]etype new password:"], timeout=20, error_msg="No se recibio el prompt 'Retype new password:' de JUNOS.")
        child.sendline(JUNIPER_ROOT_PASSWORD)
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

    requiere("sudo", "zpe")
    print("--- PASO: Configuracion Automatica del ZPE via Consola Serial ---")

    mensaje = (
        "Conecte cable consola al puerto CONSOLE del ZPE y el otro extremo "
        "a un puerto USB 3.0 del Superlogics/ABMX."
    )

    # --- PASO A: Exigir ENTER del usuario y validar el cable de consola antes de continuar ---
    child, used_device = _wait_for_console_connection_enter(mensaje, ["/dev/ttyUSB0", "/dev/ttyUSB1"], 115200, "cable_zpe")
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
            r"\[admin@nodegrid[^\]]*\]#\s",
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
            child.sendline(ZPE_PASSWORD)
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
            child.sendline(ZPE_PASSWORD)
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
    new_line = f"host zpe {{ hardware ethernet {zpe_mac}; fixed-address {CFG['zpe_ip']}; }}"
    sed_cmd = (
        "sudo sed -i '/host zpe { hardware ethernet/c\\"
        f"{new_line}' /etc/dhcp/dhcpd.conf"
    )
    run_interactive(sed_cmd)

    print("[*] Verificando que la MAC se haya aplicado correctamente...")
    run_interactive(f"sudo grep -q '{zpe_mac}' /etc/dhcp/dhcpd.conf")

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
    sudo_user = usuario()
    zpe_script_dir = f"/home/{sudo_user}/lego-infra/lego_setup/lego_zpe_console_server"
    ssh_cmd = (
        f"cd {zpe_script_dir} && "
        f"ssh -t -t -v -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new {CFG['zpe_user']}@{CFG['zpe_ip']} < lego_config_zpe_allports.sh"
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
        ssh_child.sendline(ZPE_PASSWORD)
        idx2 = ssh_child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=540)
        if idx2 != 0:
            print_ascii_fail()
            ssh_child.close(force=True)
            raise RuntimeError("Timeout esperando que finalice lego_config_zpe_allports.sh via SSH.")
    elif idx == 1:
        print("[=] La sesion SSH finalizo sin solicitar password (posible autenticacion por llave).")
    else:
        print_ascii_fail()
        ssh_child.close(force=True)
        raise RuntimeError("Timeout esperando el prompt de password SSH hacia el ZPE (10.0.0.253).")

    ssh_child.close()
    if ssh_child.exitstatus not in (0, None):
        print_ascii_fail()
        raise RuntimeError(
            f"Error ejecutando lego_config_zpe_allports.sh via SSH (Exit code: {ssh_child.exitstatus})"
        )

    _print_green_banner("CONFIGURACION DEL ZPE COMPLETADA EXITOSAMENTE.")
    mark_step_completed("zpe_config", datos_zpe)
    
def _scp_download(remote_user, remote_host, remote_path, destination="."):
    """Descarga (recursivamente) 'remote_path' desde 'remote_user@remote_host' hacia
    'destination' via scp, manejando el prompt de huella SSH y de contrasena
    (se usa SUDO_PASSWORD, siguiendo la misma convencion que run_scp_from_mirror
    y download_python_tools)."""
    cmd = f"scp -r {remote_user}@{remote_host}:{remote_path} {destination}"
    print(f"[CMD Interactive] {cmd}")

    child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=1800)
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
            print_ascii_fail()
            raise RuntimeError(f"Timeout copiando '{remote_path}' desde {remote_host}.")

    child.close()
    if child.exitstatus != 0:
        print_ascii_fail()
        raise RuntimeError(
            f"Error copiando '{remote_path}' desde {remote_host} (Exit code: {child.exitstatus})."
        )

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

    requiere("sudo")
    remote_host = CFG["vrmu_host"]
    sudo_user = usuario()
    remote_user = sudo_user
    home_dir = f"/home/{sudo_user}"

    # --- PASO 1: Descargar por SCP los directorios/archivos necesarios ---
    items_to_download = [
        "viperfish-dvc",
        "vrmu_util",
        "ledare_1_*",
        "FWContainer_EN_3_AP_00_02_00_09.bin",
    ]

    for item in items_to_download:
        remote_path = f"/home/{remote_user}/{item}"
        print(f"[*] Descargando '{item}' desde {remote_host}...")
        _scp_download(remote_user, remote_host, remote_path, destination=".")

    # --- PASO 2: Copiar la imagen 'tross' de viperfish-dvc/vin-sweep a /tftpboot/ ---
    # Comandos enviados por separado (no encadenados con '&&'), tal como en el runbook.
    # NOTA: se agrega 'sudo' al 'cp' (no presente en el runbook original) porque
    # /tftpboot/ es un directorio de sistema que normalmente requiere permisos
    # elevados, siguiendo la misma convencion usada en el resto del script
    # para escrituras fuera del home del usuario.
    print("[*] Copiando imagen 'tross' a /tftpboot/...")
    _run_shell_sequence([
        "cd viperfish-dvc/vin-sweep/",
        "sudo cp -r tross /tftpboot/",
    ])

    # --- PASO 3: Copiar vrmu_util al home del usuario y darle permisos de ejecucion ---
    # Comandos enviados por separado (no encadenados con '&&'), tal como en el runbook.
    print("[*] Copiando vrmu_util al home y asignando permisos...")

    downloaded_vrmu_path = os.path.abspath("vrmu_util")
    home_vrmu_path = os.path.join(home_dir, "vrmu_util")

    if (os.path.exists(downloaded_vrmu_path) and os.path.exists(home_vrmu_path)
            and os.path.samefile(downloaded_vrmu_path, home_vrmu_path)):
        # El script ya se ejecuto desde el home del usuario, por lo que 'vrmu_util'
        # descargado en el PASO 1 ya es el mismo archivo que '~/vrmu_util'.
        # 'cp' fallaria con "same file", asi que solo aplicamos el chmod.
        print("[=] 'vrmu_util' ya se encuentra en el home del usuario. Omitiendo la copia, solo se ajustan permisos...")
        _run_shell_sequence([
            "cd",
            "chmod 777 vrmu_util",
        ])
    else:
        _run_shell_sequence([
            "cd",
            "cp vrmu_util ~",
            "chmod 777 vrmu_util",
        ])

    print("[✓] Configuracion de VRMU Util completada exitosamente.")
    mark_step_completed("vrmu_util_config")

def tross_aplicar_mac(mac_input):
    """Pone la MAC del Tross en /etc/dhcp/dhcpd.conf y reinicia el DHCP. Se usa con --tross-mac."""
    requiere("sudo")
    print("--- TROSS: MAC en el DHCP ---")
    clean_mac = re.sub(r'[^0-9a-fA-F]', '', mac_input or "")
    if len(clean_mac) != 12:
        print_ascii_fail()
        raise ValueError(f"La MAC no es valida (se esperaban 12 caracteres hexadecimales, llegaron {len(clean_mac)}): '{mac_input}'")
    tross_mac = ":".join(clean_mac[i:i + 2] for i in range(0, 12, 2)).lower()
    print(f"[+] MAC normalizada del Tross: {tross_mac}")
    new_line = f"host tross {{ hardware ethernet {tross_mac}; fixed-address {CFG['tross_ip']}; }}"
    if subprocess.run(["grep", "-q", "host tross { hardware ethernet", "/etc/dhcp/dhcpd.conf"]).returncode == 0:
        run_interactive("sudo sed -i '/host tross { hardware ethernet/c\\" + new_line + "' /etc/dhcp/dhcpd.conf")
    else:
        run_interactive(f"echo '{new_line}' | sudo tee -a /etc/dhcp/dhcpd.conf > /dev/null")
    run_interactive(f"sudo grep -q '{tross_mac}' /etc/dhcp/dhcpd.conf")
    print("[*] Reiniciando el DHCP para que el Tross tome su IP...")
    run_interactive("sudo systemctl restart isc-dhcp-server")
    state = load_state(); state.setdefault("config", {})["tross_mac"] = tross_mac; save_state(state)
    print(f"[✓] MAC del Tross aplicada: {tross_mac} -> {CFG['tross_ip']}")

def download_python_tools():
    if is_step_completed("download_python_tools"):
        print("[=] Paso 'download_python_tools' ya fue ejecutado previamente. Omitiendo...")
        return

    print("--- PASO: Descarga de Herramientas Python por SCP ---")
    
    requiere("sudo")
    remote_host = CFG["tools_host"]
    sudo_user = usuario()
    remote_user = sudo_user
    
    files_to_download = [
        "dhcpd.py",
        "UUT_test_case.py",
        "share.py",
        "reboot.py",
        "U22Tocinos"
    ]
    
    destination_dir = "."
    
    for filename in files_to_download:
        remote_path = f"{remote_user}@{remote_host}:/home/{remote_user}/{filename}"
        cmd = f"scp {remote_path} {destination_dir}/"
        
        print(f"[*] Descargando {filename} por SCP...")
        print(f"[CMD Interactive] {cmd}")
        
        child = pexpect.spawn("bash", ["-c", cmd], encoding="utf-8", timeout=1800)
        
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
                pexpect.EOF,
                pexpect.TIMEOUT
            ], timeout=1800)

            if idx == 0:
                print("\n[*] Detectado prompt de huella SSH. Enviando 'yes'...")
                child.sendline("yes")
            elif idx == 1:
                print("\n[*] Ingresando contraseña para SCP...")
                child.sendline(SUDO_PASSWORD)
            elif idx == 2:
                break
            elif idx == 3:
                child.close(force=True)
                print_ascii_fail()
                raise RuntimeError(f"Timeout descargando {filename} desde {remote_host}.")

        child.close()

        if child.exitstatus != 0:
            print_ascii_fail()
            raise RuntimeError(f"Error descargando {filename} por SCP (Exit code: {child.exitstatus})")

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
    run_command("sudo rm -rf ~/.config/google-chrome", check=False)
    run_command("sudo rm -rf ~/.cache/google-chrome", check=False)

    print("[*] Descargando e instalando nuevamente la llave GPG oficial de Google...")
    run_interactive(
        "wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/google-chrome.gpg"
    )

    print("[*] Configurando el repositorio oficial de Google Chrome...")
    repo_cmd = 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list'
    run_interactive(repo_cmd)

    print("[*] Actualizando listas de paquetes de apt...")
    run_interactive("sudo apt-get update")

    print("[*] Instalando Google Chrome Stable...")
    run_interactive("sudo apt-get install google-chrome-stable -y")

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
        subprocess.run(f'echo "{SUDO_PASSWORD}" | sudo -S reboot', shell=True, timeout=30)
        print("[✓] Comando de reinicio enviado correctamente (fallback subprocess).")
        return
    except Exception as e:
        print(f"[!] El fallback por subprocess tambien fallo: {e}")

    # --- Intento 3: ultimo recurso, reboot forzado (reboot -f) ---
    print("[*] Ultimo recurso: forzando el reinicio con 'reboot -f'...")
    try:
        subprocess.run(f'echo "{SUDO_PASSWORD}" | sudo -S reboot -f', shell=True, timeout=30)
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

    print(f"\n{GREEN}{'='*60}")
    print("           CONFIGURACION TERMINADA EXITOSAMENTE           ")
    print(f"{'='*60}{RESET}")
    
    print(f"{GREEN}[+] Pasos completados ({len(completed_steps)}):{RESET}")
    for step in completed_steps:
        print(f"{GREEN}    - {step}{RESET}")
    print(f"{GREEN}    - end_config_reboot (En proceso...){RESET}")
    print(f"{GREEN}{'='*60}\n{RESET}")

    mark_step_completed("end_config_reboot")

    respuesta = pedir("reinicio", "Configuracion del servidor terminada. ¿Reiniciar ahora? (si/no):").strip().lower()
    if respuesta not in ("si", "sí", "s", "yes", "y"):
        print("[=] Reinicio pospuesto. Reinicia el servidor cuando puedas para aplicar todo.")
        return

    # NOTA: aqui antes se llamaba a log_final_summary(), que CIERRA el archivo
    # de log. Como sys.stdout/sys.stderr siguen redirigidos al DualLogger, el
    # primer print() posterior a ese cierre lanzaba una excepcion (escritura
    # sobre archivo cerrado) que mataba el script ANTES de llegar a ejecutar
    # el reboot. Se reemplaza por un flush+fsync que NO cierra el archivo, y
    # el cierre real se deja como ultimo paso, ya con el reinicio en curso.
    print("\n\n[*] Forzando el flush del log a disco (sin cerrarlo) antes del reboot...")
    _flush_log_to_disk()

    print("[*] Forzando el reinicio del sistema...")
    _force_reboot()

    print("[*] Cerrando el log de ejecucion...")
    log_final_summary()

# ==============================================================================
# PASOS (en orden). La app muestra esta misma lista. El Tross va aparte (--tross-mac).
# ==============================================================================
PASOS = [
    ("set_ID", set_ID, ()),
    ("set_network", set_network, ("sudo",)),
    ("gitconfig_cookie", gitconfig_cookie, ("mirror",)),
    ("flex_tag", flex_tag, ("sudo",)),
    ("run_security_patch", run_security_patch, ("sudo",)),
    ("validate_and_lego_setup", validate_and_lego_setup, ("sudo",)),
    ("setup_nomachine_yaml", setup_nomachine_yaml, ()),
    ("run_ansible_playbook", run_ansible_playbook, ("sudo", "vault")),
    ("provisional_dhcp", provisional_dhcp, ("sudo",)),
    ("network_plan", network_plan, ("sudo",)),
    ("force_test_network_selection", force_test_network_selection, ("sudo",)),
    ("reinstall_goss", reinstall_goss, ("sudo",)),
    ("run_final_abmx_config", run_final_abmx_config, ("sudo", "vault", "mirror")),
    ("create_networkmanager_symlink", create_networkmanager_symlink, ("sudo",)),
    ("juniper_config", juniper_config, ("sudo", "juniper")),
    ("zpe_config", zpe_config, ("sudo", "zpe")),
    ("vrmu_util_config", vrmu_util_config, ("sudo",)),
    ("download_python_tools", download_python_tools, ("sudo",)),
    ("fix_chrome", fix_chrome, ("sudo",)),
    ("end_config_reboot", end_config_reboot, ("sudo",)),
]

def correr_paso(nombre, fn, passes):
    if is_step_completed(nombre):
        aviso(paso=nombre, estado="omitido")
        print(f"[=] Paso '{nombre}' ya fue ejecutado previamente. Omitiendo...")
        return
    aviso(paso=nombre, estado="inicio")
    t0 = time.time()
    try:
        if not pexpect and nombre not in ("set_ID", "setup_nomachine_yaml"):
            raise RuntimeError("Falta el modulo pexpect de Python. Instalalo con: sudo apt install python3-pexpect")
        requiere(*passes)
        fn()
    except BaseException as e:   # incluye sys.exit del downgrade del Juniper
        if isinstance(e, KeyboardInterrupt):
            aviso(paso=nombre, estado="fallo", error="Detenido por el usuario")
            raise
        msg = str(e) or e.__class__.__name__
        if isinstance(e, SystemExit):
            msg = f"El paso terminó el script (código {e.code})"
        aviso(paso=nombre, estado="fallo", error=msg[:600], seg=round(time.time() - t0, 1))
        print(f"\n[✕] Falló el paso '{nombre}': {msg}")
        sys.exit(1)
    if is_step_completed(nombre):
        aviso(paso=nombre, estado="ok", seg=round(time.time() - t0, 1))
    else:
        aviso(paso=nombre, estado="fallo", error="El paso terminó sin marcarse como hecho.", seg=round(time.time() - t0, 1))
        sys.exit(1)

def principal():
    ap = argparse.ArgumentParser(description="Aprovisionamiento del servidor Ghostfish (Connection Validation)")
    ap.add_argument("--paso", help="Corre solo este paso, aunque ya esté hecho")
    ap.add_argument("--estado", action="store_true", help="Imprime en JSON qué pasos están hechos")
    ap.add_argument("--lista", action="store_true", help="Imprime los nombres de los pasos")
    ap.add_argument("--tross-mac", help="Pone la MAC del Tross en el DHCP y lo reinicia")
    args = ap.parse_args()
    nombres = [n for n, _, _ in PASOS]

    if args.lista:
        print(json.dumps(nombres)); return
    if args.estado:
        st = load_state()
        print(json.dumps({"flags": {n: bool(st.get("flags", {}).get(n)) for n in nombres}, "config": st.get("config", {})}, ensure_ascii=False))
        return

    activar_log()
    print("[*] Activando sudo de forma automatica...")
    if _activate_sudo():
        print("[✓] Sudo activado correctamente.")
    else:
        print("[!] No se pudo confirmar la activacion inicial de sudo.")

    if args.tross_mac:
        aviso(paso="tross", estado="inicio")
        try:
            tross_aplicar_mac(args.tross_mac)
        except BaseException as e:
            aviso(paso="tross", estado="fallo", error=str(e)[:600]); print(f"[✕] {e}"); sys.exit(1)
        aviso(paso="tross", estado="ok"); return

    if args.paso:
        if args.paso not in nombres:
            print(f"[✕] No existe el paso '{args.paso}'. Pasos: {', '.join(nombres)}"); sys.exit(2)
        st = load_state()
        if st.get("flags", {}).pop(args.paso, None) is not None:
            save_state(st)   # se quita la palomita para correrlo de nuevo
        nombre, fn, passes = next(x for x in PASOS if x[0] == args.paso)
        correr_paso(nombre, fn, passes)
        aviso(fin="paso", paso=nombre)
        return

    for nombre, fn, passes in PASOS:
        correr_paso(nombre, fn, passes)
    aviso(fin="todo")

if __name__ == "__main__":
    principal()
