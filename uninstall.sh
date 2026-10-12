#!/usr/bin/env bash
# Services Dashboard Uninstaller
# Stops and removes systemd user service, desktop menu launcher, application icon, and CLI symlink.

set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
ICON_PNG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="services-dashboard.service"

echo "Uninstalling Services Dashboard..."

# 1. Stop and disable systemd user service
if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        echo "Stopping systemd user service..."
        systemctl --user stop "${SERVICE_NAME}"
    fi

    if systemctl --user is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
        echo "Disabling systemd user service..."
        systemctl --user disable "${SERVICE_NAME}"
    fi
fi

# 2. Stop any standalone running instances
pkill -f "app.py" 2>/dev/null || true

# 3. Remove installed files
rm -f "${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
rm -f "${DESKTOP_DIR}/services-dashboard.desktop"
rm -f "${ICON_DIR}/services-dashboard.svg"
rm -f "${ICON_PNG_DIR}/services-dashboard.png"
rm -f "${BIN_DIR}/services-dashboard"

echo "Removed installed desktop, icon, service, and CLI files."

# 4. Reload systemd daemon
if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
fi

# 5. Refresh desktop and icon databases
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${DESKTOP_DIR}" >/dev/null 2>&1 || true
fi
if command -v kbuildsycoca6 >/dev/null 2>&1; then
    kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
elif command -v kbuildsycoca5 >/dev/null 2>&1; then
    kbuildsycoca5 --noincremental >/dev/null 2>&1 || true
fi

echo "Uninstallation complete."
