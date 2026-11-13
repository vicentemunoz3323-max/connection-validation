import pyvisa
import time

IP_EQUIPO = "10.0.0.100"
RECURSO_VISA = f"TCPIP0::{IP_EQUIPO}::inst0::INSTR"

def leer_16_canales():
    rm = pyvisa.ResourceManager()
    try:
        daq = rm.open_resource(RECURSO_VISA)
        daq.timeout = 20000  # Subimos a 20 segundos por seguridad

        identificacion = daq.query("*IDN?").strip()
        print(f"Conectado a: {identificacion}\n")

        # Abortar cualquier escaneo que estuviera corriendo y limpiar errores
        daq.write("ABOR")
        daq.write("*CLS")

        # Configurar canales 101 al 116 en Voltaje DC
        canales = "(@101:116)"
        daq.write(f"CONF:VOLT:DC AUTO, {canales}")

        # Hacer la medición rápida (1 ciclo de línea por canal = ~16 ms por canal)
        daq.write(f"SENS:VOLT:DC:NPLC 1, {canales}")

        # Verificar si el DAQ970A aceptó la configuración sin errores
        error_daq = daq.query("SYST:ERR?").strip()
        if not error_daq.startswith("+0"):
            print(f"⚠️ El DAQ reportó un problema de configuración: {error_daq}")
            print("Revisa qué modelo de tarjeta tienes en el Slot 1 (ej. DAQM901A tiene 20 canales de voltaje, pero otros módulos tienen menos).")
            return

        # Definir lista de escaneo e iniciar lectura
        daq.write(f"ROUT:SCAN {canales}")

        print("Escaneando canales...")
        respuesta = daq.query("READ?").strip()

        valores = [float(v) for v in respuesta.split(",")]

        print("\n--- Lecturas de los canales 101 al 116 ---")
        for i, valor in enumerate(valores, start=1):
            canal_fisico = 100 + i
            print(f"Canal {i:02d} ({canal_fisico}): {valor:.6f} V")

    except Exception as e:
        print(f"Error de comunicación con el equipo: {e}")
    finally:
        if 'daq' in locals():
            daq.close()
        rm.close()

if __name__ == "__main__":
    leer_16_canales()
