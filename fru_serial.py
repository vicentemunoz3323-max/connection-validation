#!/usr/bin/env python3

"""Regression Helper for OpenTest.

This daemon can be used to loop multiple tests unattended on OpenTest for
capturing data for regression, GR&R, and stability testing.
"""

import argparse
import json
import random
import requests
import time
from colorama import Fore, init
#from send_ff import envio_FSC
import subprocess
import telnetlib
import socket
import paramiko
import re
from datetime import datetime
import os

# Inicializar colorama para que los colores funcionen correctamente en la terminal
init(autoreset=True)

def ping_unit(station_id):
    unit = f"10.0.0.{station_id}"  # El rango de las unidades o slot en el rack 1-12
    end_time = time.time() + 300   # tiempo en el que hace el intento de ping 300s = 5 minutos

    while time.time() < end_time:
        out = subprocess.run(["ping", "-c", "1", unit], stdout=subprocess.DEVNULL)
        if out.returncode == 0:
            return True
    print(Fore.WHITE + "Validacion por ping hacia la Astoria..." + Fore.RED + "ERROR")
    return False

def fru_data(station_id):
    if not ping_unit(station_id):
        print(Fore.WHITE + "Validacion por ping hacia la unidad GLP..." + Fore.RED + "ERROR")
        return False

    zpe_ip = "10.0.0.253"
    expected_message_dos = b"(none) login: "
    port = 7000 + station_id  # Ajustar el puerto en función del ID de la estación
    tn = None # Definir la variable antes del bloque try

    try:
        tn = telnetlib.Telnet(zpe_ip, port, timeout=10)
        tn.write(b"\n")
        tn.read_until(expected_message_dos, timeout=5)

        tn.write(b"root\n")
        tn.read_until(b"(none):~# ", timeout=5)

        tn.write(b"ssh root@fe80::21a:11ff:fe16:fead%gbmcbr\n")
        tn.read_until(b"root@fe80::21a:11ff:fe16:fead%gbmcbr's password: ", timeout=10)

        tn.write(b"0penBmc\n")
        tn.read_until(b"root@ghostlite:~# ", timeout=10)

        tn.write(b"hexdump -C -n256 /sys/bus/i2c/drivers/at24/150-0050/eeprom\n")
        response = tn.read_until(b"root@ghostlite:~# ", timeout=10).decode('utf-8')

        # 1. Búsqueda del Serial Number (Formato FLGXXXX-XXXXX)
        serial_match = re.search(r'\bFLG\d{4}-\d{5}\b', response)
        if serial_match:
            print(Fore.GREEN + "El serial correcto es: " + Fore.WHITE + serial_match.group(0))
        else:
            print(Fore.YELLOW + "No se encontró el Serial Number con formato FLGXXXX-XXXXX")

        # 2. Búsqueda del Primer Part Number (1231778)
        part1_match = re.search(r'1231778', response)
        if part1_match:
            print(Fore.GREEN + "El part number correcto es: " + Fore.WHITE + part1_match.group(0))
        else:
            print(Fore.YELLOW + "No se encontró el part number: 1231778")

        # 3. Búsqueda del Segundo Part Number (1227014)
        part2_match = re.search(r'1227014', response)
        if part2_match:
            print(Fore.GREEN + "El part number correcto es: " + Fore.WHITE + part2_match.group(0))
        else:
            print(Fore.YELLOW + "No se encontró el part number: 1227014")

        # Salida limpia de las sesiones de consola
        tn.write(b"exit\n")
        tn.read_until(b"(none):~# ", timeout=5)
        tn.write(b"exit\n")
        tn.close()
        return response

    except Exception as e:
        print(Fore.RED + f"No se pudo conectar o interactuar con {zpe_ip}:{port} - {str(e)}")
        # Solo intentar cerrar si la conexión Telnet logró abrirse
        if tn:
            try:
                tn.write(b"exit\n")
                tn.close()
            except:
                pass
        return False

def main():
    while True:
        try:
            slot_id = int(input("Ingrese el numero de slot (1-16): "))
            if 0 < slot_id <= 16:
                break
            else:
                print(Fore.RED + 'El número debe estar entre 1 y 16.')
        except ValueError:
            print(Fore.RED + 'Por favor, ingrese un número válido.')

    fru_data(slot_id)

if __name__ == '__main__':
    main()
