#!/bin/bash

# ==============================================================================
# SCRIPT DE DESPLIEGUE Y CONFIGURACIÓN: PASS
# Va dentro de Connection Validation (Configuración → CHILLER MONITOR). La app lo corre en segundo plano.
# Cambio para correr sin terminal: scp acepta la huella del servidor la primera vez (StrictHostKeyChecking=accept-new).
# Nivel: Producción / Blindado / Set-and-Forget
# ==============================================================================

# CONFIGURACIÓN DE COLORES
ROJO='\033[0;31m'
VERDE='\033[0;32m'
CYAN='\033[0;36m'
SIN_COLOR='\033[0m' # Reset color

# CREDENCIALES Y RUTAS (Contraseña unificada: 55eed35fba)
MI_PASSWORD="55eed35fba"
RED_PASSWORD="55eed35fba"
ARCHIVO="/etc/systemd/system/chillermonitor.service"
REMOTE_IP="172.24.125.166"

echo -e "${CYAN}=== [1/5] Verificando servicio local ===${SIN_COLOR}"

# 1. Validación de existencia del archivo de servicio
if [ ! -f "$ARCHIVO" ]; then
    echo -e "${ROJO}[ERROR CRÍTICO] No se encuentra el archivo $ARCHIVO en la ruta especificada.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi

# 2. Candado de idempotencia y modificación segura
if grep -q "flex_sensor_config.ini" "$ARCHIVO"; then
    echo -e "${CYAN}[AVISO] El servicio ya cuenta con la configuración aplicada. Omitiendo sed...${SIN_COLOR}"
else
    echo "Aplicando modificación en el servicio..."
    echo "$MI_PASSWORD" | sudo -S sed -i '/ExecStart/ { s/^/#/; a ExecStart=/usr/bin/python3 -m stew.services.chiller_monitor.chiller_monitor -c /home/testusr/opentest-google-stew/stew/services/chiller_monitor/config/flex_sensor_config.ini
}' "$ARCHIVO"
    
    if [ $? -ne 0 ]; then
        echo -e "${ROJO}[ERROR] Falló la modificación del archivo con sed.${SIN_COLOR}"
        read -p "Presiona cualquier tecla para salir..." -n1 -s
        exit 1
    fi
    echo -e "${VERDE}[OK] Línea comentada y servicio configurado con éxito.${SIN_COLOR}"
fi

# 3. Descarga vía SCP con validación de error
echo -e "\n${CYAN}=== [2/5] Descargando archivos remotos vía SCP ===${SIN_COLOR}"

sshpass -p "$RED_PASSWORD" scp -o StrictHostKeyChecking=accept-new "$REMOTE_IP:/home/testusr/opentest-google-stew/stew/services/chiller_monitor/module/data_logging.py" .
if [ $? -ne 0 ]; then
    echo -e "${ROJO}[ERROR] Falló la descarga remota de 'data_logging.py' via SCP.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi

sshpass -p "$RED_PASSWORD" scp -o StrictHostKeyChecking=accept-new "$REMOTE_IP:/home/testusr/opentest-google-stew/stew/services/chiller_monitor/config/flex_sensor_config.ini" .
if [ $? -ne 0 ]; then
    echo -e "${ROJO}[ERROR] Falló la descarga remota de 'flex_sensor_config.ini' via SCP.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi
echo -e "${VERDE}[OK] Archivos descargados correctamente.${SIN_COLOR}"

# 4. Mover archivos con sudo y validación
echo -e "\n${CYAN}=== [3/5] Moviendo archivos a directorios del sistema ===${SIN_COLOR}"

echo "$MI_PASSWORD" | sudo -S mv data_logging.py /home/testusr/opentest-google-stew/stew/services/chiller_monitor/module/
if [ $? -ne 0 ]; then
    echo -e "${ROJO}[ERROR] No se pudo mover 'data_logging.py' a su ruta final.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi

echo "$MI_PASSWORD" | sudo -S mv flex_sensor_config.ini /home/testusr/opentest-google-stew/stew/services/chiller_monitor/config/
if [ $? -ne 0 ]; then
    echo -e "${ROJO}[ERROR] No se pudo mover 'flex_sensor_config.ini' a su ruta final.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi
echo -e "${VERDE}[OK] Archivos reubicados con éxito.${SIN_COLOR}"

# 5. Recarga de Systemd y reinicio con validación
echo -e "\n${CYAN}=== [4/5] Aplicando cambios en Systemd y reiniciando servicio ===${SIN_COLOR}"

echo "$MI_PASSWORD" | sudo -S systemctl daemon-reload
if [ $? -ne 0 ]; then
    echo -e "${ROJO}[ERROR] Falló el comando daemon-reload.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi

echo "$MI_PASSWORD" | sudo -S systemctl restart chillermonitor.service
if [ $? -ne 0 ]; then
    echo -e "${ROJO}[ERROR] El servicio chillermonitor.service falló al reiniciar.${SIN_COLOR}"
    read -p "Presiona cualquier tecla para salir..." -n1 -s
    exit 1
fi
echo -e "${VERDE}[OK] Servicio reiniciado correctamente.${SIN_COLOR}"

# 6. Lanzamiento de navegadores
echo -e "\n${CYAN}=== [5/5] Abriendo dashboards en Google Chrome ===${SIN_COLOR}"
google-chrome 127.0.0.1:8090/open_test &>/dev/null &
google-chrome 127.0.0.1:5000 &>/dev/null &
google-chrome 10.0.0.100 &>/dev/null &
echo -e "${VERDE}[OK] Dashboards lanzados.${SIN_COLOR}"

# ==============================================================================
# LOGO FINAL: PASS (EN VERDE) + ARTE KAOMOJI
# ==============================================================================
echo -e "\n${VERDE}"
echo "  ____  _    ____ ____  "
echo " |  _ \/ \  / ___/ ___| "
echo " | |_) / _ \ \___ \___ \ "
echo " |  __/ ___ \ ___) |__) |"
echo " |_| /_/   \_\____/____/ "
echo -e "${SIN_COLOR}"

echo -e "${CYAN}"
echo "            C· プ°"
echo "           \\ (  )"
echo "             \\ \\"
echo -e "${SIN_COLOR}"

echo -e "${VERDE}=============================================================================="
echo "         ¡TODO EL DESPLIEGUE FINALIZÓ CON ÉXITO Y SIN ERRORES!                "
echo "==============================================================================${SIN_COLOR}"

# Pausa final para que el usuario presione una tecla antes de cerrar
echo -e "\n"
read -p "Presiona cualquier tecla para salir..." -n1 -s
echo -e "\n"