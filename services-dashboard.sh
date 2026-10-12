#!/usr/bin/env bash
# Services Dashboard CLI & Browser Launcher
# Portable launcher for Services Dashboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SERVICES_DASHBOARD_PORT:-5100}"
URL="http://localhost:${PORT}"
ACTION="${1:-launch}"
SERVICE_NAME="services-dashboard.service"

is_running() {
    curl -s --connect-timeout 1 "${URL}/api/status" >/dev/null 2>&1
}

wait_for_server() {
    local timeout=15
    local count=0
    while ! is_running; do
        sleep 0.5
        count=$((count + 1))
        if [ "$count" -ge $((timeout * 2)) ]; then
            echo "Error: Timed out waiting for Services Dashboard to start." >&2
            return 1
        fi
    done
}

ensure_server() {
    if is_running; then
        return 0
    fi

    if command -v systemctl >/dev/null 2>&1; then
        if systemctl --user list-unit-files "${SERVICE_NAME}" >/dev/null 2>&1; then
            echo "Starting ${SERVICE_NAME} via systemd..."
            systemctl --user start "${SERVICE_NAME}"
            wait_for_server
            return 0
        fi
    fi

    echo "Starting Services Dashboard in background on port ${PORT}..."
    nohup python3 "${SCRIPT_DIR}/app.py" >/dev/null 2>&1 &
    wait_for_server
}

open_browser() {
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${URL}" >/dev/null 2>&1 &
    elif command -v gio >/dev/null 2>&1; then
        gio open "${URL}" >/dev/null 2>&1 &
    else
        echo "Open your browser to: ${URL}"
    fi
}

case "${ACTION}" in
    launch)
        ensure_server
        open_browser
        ;;
    start)
        ensure_server
        echo "Services Dashboard is running at ${URL}"
        ;;
    stop)
        if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
            echo "Stopping systemd service ${SERVICE_NAME}..."
            systemctl --user stop "${SERVICE_NAME}"
        else
            echo "Stopping standalone instances..."
            pkill -f "app.py" 2>/dev/null || true
        fi
        echo "Services Dashboard stopped."
        ;;
    restart)
        if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
            echo "Restarting ${SERVICE_NAME}..."
            systemctl --user restart "${SERVICE_NAME}"
        else
            echo "Restarting Services Dashboard..."
            pkill -f "app.py" 2>/dev/null || true
            sleep 1
            ensure_server
        fi
        echo "Services Dashboard restarted at ${URL}"
        ;;
    status)
        if is_running; then
            echo "Services Dashboard is running at ${URL}"
            if command -v systemctl >/dev/null 2>&1; then
                systemctl --user status "${SERVICE_NAME}" --no-pager 2>/dev/null || true
            fi
        else
            echo "Services Dashboard is not running."
            exit 1
        fi
        ;;
    open)
        open_browser
        ;;
    logs)
        if command -v journalctl >/dev/null 2>&1; then
            journalctl --user -u "${SERVICE_NAME}" -f
        else
            echo "journalctl is not available."
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 [launch|start|stop|restart|status|open|logs]"
        exit 1
        ;;
esac
