#!/bin/bash
# Registra el ícono de Connection Validation en Ubuntu, en todos sus tamaños,
# y crea su acceso en el menú de aplicaciones (para usarla desde esta carpeta con "npm start").
# Uso:  bash instalar-iconos.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NOMBRE="ghostfish-engine"

for t in 16 22 24 32 48 64 96 128 256 512; do
  mkdir -p "$HOME/.local/share/icons/hicolor/${t}x${t}/apps"
  cp "$DIR/icons/${t}x${t}.png" "$HOME/.local/share/icons/hicolor/${t}x${t}/apps/$NOMBRE.png"
done
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/$NOMBRE.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Connection Validation
Comment=Connection validation · DRDT
Exec=bash -c 'cd "$DIR" && npm start'
Icon=$NOMBRE
Terminal=false
Categories=Utility;
StartupWMClass=$NOMBRE
DESK
update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
echo "✔ Íconos instalados (10 tamaños) y acceso creado en el menú: Connection Validation"
