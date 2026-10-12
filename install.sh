#!/usr/bin/env bash
# Services Dashboard Installer
# Installs application icon, desktop launcher, CLI symlink, and systemd user service.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
ICON_PNG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PYTHON_BIN="$(command -v python3 || echo "/usr/bin/python3")"

echo "Installing Services Dashboard..."

# 1. Check Python dependencies
check_dependencies() {
    local missing=()
    for mod in fastapi uvicorn pydantic; do
        if ! "${PYTHON_BIN}" -c "import ${mod}" >/dev/null 2>&1; then
            missing+=("${mod}")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        echo "Notice: Some Python dependencies are not installed: ${missing[*]}"
        echo "You can install them via pip or your package manager:"
        echo "  pip install -r ${REPO_DIR}/requirements.txt"
        echo "  Fedora / Nobara: sudo dnf install python3-fastapi python3-uvicorn python3-pydantic"
        echo "  Ubuntu / Debian: sudo apt install python3-fastapi python3-uvicorn python3-pydantic"
        echo "  Arch Linux:      sudo pacman -S python-fastapi python-uvicorn python-pydantic"
        echo ""
    fi
}

check_dependencies

# 2. Create required target directories
mkdir -p "${BIN_DIR}" "${DESKTOP_DIR}" "${ICON_DIR}" "${ICON_PNG_DIR}" "${SYSTEMD_USER_DIR}"

# 3. Ensure repository scripts are executable
chmod +x "${REPO_DIR}/services-dashboard.sh"

# 4. Install application icons
if [ -f "${REPO_DIR}/static/favicon.svg" ]; then
    cp -f "${REPO_DIR}/static/favicon.svg" "${ICON_DIR}/services-dashboard.svg"
    echo "Installed application icon: ${ICON_DIR}/services-dashboard.svg"
fi
if [ -f "${REPO_DIR}/static/favicon.png" ]; then
    cp -f "${REPO_DIR}/static/favicon.png" "${ICON_PNG_DIR}/services-dashboard.png"
    echo "Installed application icon: ${ICON_PNG_DIR}/services-dashboard.png"
fi

# 5. Create CLI symlink in ~/.local/bin
ln -sf "${REPO_DIR}/services-dashboard.sh" "${BIN_DIR}/services-dashboard"
echo "Created CLI command link: ${BIN_DIR}/services-dashboard"

# 6. Generate and install desktop menu launcher
cat > "${DESKTOP_DIR}/services-dashboard.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Services Dashboard
GenericName=Service & Container Monitor
Comment=Monitor and manage rootless containers, user services, and system tasks
Exec=${BIN_DIR}/services-dashboard launch
Icon=services-dashboard
Terminal=false
Categories=Utility;System;Monitor;
Keywords=systemd;podman;docker;containers;services;tasks;timers;cron;dashboard;
StartupNotify=true
EOF
chmod 644 "${DESKTOP_DIR}/services-dashboard.desktop"
echo "Installed desktop menu launcher: ${DESKTOP_DIR}/services-dashboard.desktop"

# 7. Generate and install systemd user service
cat > "${SYSTEMD_USER_DIR}/services-dashboard.service" <<EOF
[Unit]
Description=Services Dashboard - Background Services & Tasks
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${PYTHON_BIN} ${REPO_DIR}/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
chmod 644 "${SYSTEMD_USER_DIR}/services-dashboard.service"
echo "Installed systemd user service: ${SYSTEMD_USER_DIR}/services-dashboard.service"

# 8. Reload systemd and start service
if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable --now services-dashboard.service
    echo "Services Dashboard background service enabled and started."
fi

# 9. Refresh desktop and icon databases
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${DESKTOP_DIR}" >/dev/null 2>&1 || true
fi
if command -v kbuildsycoca6 >/dev/null 2>&1; then
    kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
elif command -v kbuildsycoca5 >/dev/null 2>&1; then
    kbuildsycoca5 --noincremental >/dev/null 2>&1 || true
fi

echo ""
echo "Installation complete!"
echo "Dashboard is running at: http://localhost:5100"
echo "CLI command: services-dashboard [launch|start|stop|restart|status|open|logs]"
