# Services Dashboard

A lightweight, high-performance web dashboard for monitoring, inspecting, and managing rootless Podman Quadlet containers, user-level systemd services, scheduled timers, system maintenance tasks, and cron jobs.

### User Services View
![User Services View](assets/user-services.png)

### System Tasks View
![System Tasks View](assets/system-tasks.png)

---

## Overview

`Services-dashboard` provides a single pane of glass for Linux user services, rootless containers, and system-level maintenance tasks. Built with FastAPI and vanilla JavaScript, it runs with zero heavyweight frontend build steps, no external runtime node dependencies, and minimal memory overhead.

---

## Key Features

### 1. User Services & Containers
- **Podman Quadlet & Container Discovery**: Automatically scans and detects rootless Podman containers defined in `~/.config/containers/systemd/` as well as standalone Podman and Docker containers.
- **Systemd User Units & Timers**: Discovers and monitors background user services (`~/.config/systemd/user/`) and associated `.timer` schedules with next-trigger countdowns and last-run timestamps.
- **Port & Web App Detection**: Inspects container configs and unit files to detect published ports, providing direct launch links for self-hosted web applications.
- **Live Scoped Logs**: Stream recent service logs in real time (`journalctl --user -u <unit>`) directly in an interactive browser modal.
- **Unit File Editor & Safe Backups**: In-browser unit file editor for user `.service` and `.container` units with automatic backup creation (`.bak_<timestamp>`) before saving and daemon reload.
- **Service Controls**: Start, stop, and restart user services directly from the browser UI with automatic settle cooldowns.

### 2. System Tasks & Maintenance
- **System-Wide Maintenance Timers**: Inspects systemd system timers (such as `fstrim.timer`, `logrotate.timer`, `btrfs-scrub.timer`, `sysstat`, etc.) with next-trigger countdowns, intervals, and previous execution status.
- **Cron Job Scanner**: Scans user crontab (`crontab -l`) and system cron directories (`/etc/cron.d/`, `/etc/cron.daily/`, etc.), displaying schedules, script paths, and direct edit commands (`crontab -e`).
- **Sockets & Path Watchers**: Live visibility into active socket listeners (`*.socket`) and filesystem path monitors (`*.path`) across system and user scopes.
- **Failed Unit Diagnostics**: Real-time diagnostic section highlighting any failed or degraded units across both user and system scopes.
- **Unit Definition Inspector**: Read-only inspector (`systemctl cat`) to review raw unit definitions and drop-ins in-browser.

### 3. Personalization & Integration
- **Theme Customization**: Includes curated preset themes (Catppuccin Macchiato, Tokyo Night, Nord, and more) plus a built-in theme builder with live color preview and persistence.
- **AppIndex Integration**: Optional one-click header navigation link to a local [AppIndex](https://github.com/PlasmaDrifter/AppIndex) instance.
- **Zero-Terminal Self-Updater**: One-click in-app updater supporting both Git pull and archive extraction modes with seamless background server restart.

---

## Requirements

- Linux with `systemd` (user session enabled)
- Python 3.10+
- Podman (optional, for Quadlet and container discovery)

Python dependencies:
- `fastapi>=0.100.0`
- `uvicorn>=0.22.0`
- `pydantic>=2.0.0`

---

## Quick Start

### 1. Automated Installation (Recommended)

Clone the repository and run the installer:

```bash
git clone https://github.com/PlasmaDrifter/Services-dashboard.git
cd Services-dashboard
./install.sh
```

The installer automatically:
- Checks Python dependencies (`fastapi`, `uvicorn`, `pydantic`).
- Installs application icons to `~/.local/share/icons/hicolor/`.
- Creates a CLI command symlink `~/.local/bin/services-dashboard`.
- Creates a desktop menu launcher `~/.local/share/applications/services-dashboard.desktop`.
- Installs, reloads, and enables the systemd user service `services-dashboard.service`.

Once installed, the dashboard runs in the background and is available at:
`http://localhost:5100`

### 2. CLI Command Usage

Use the `services-dashboard` CLI command from anywhere:

```bash
# Launch dashboard in default browser (starts service if stopped)
services-dashboard launch

# Start background service
services-dashboard start

# Stop service
services-dashboard stop

# Restart service
services-dashboard restart

# Check server status
services-dashboard status

# Open browser to dashboard URL
services-dashboard open

# Stream live systemd journal logs
services-dashboard logs
```

### 3. Uninstallation

To remove the background service, desktop launcher, icons, and CLI symlink:

```bash
./uninstall.sh
```

### 4. Manual Setup (Alternative)

If you prefer to run or configure the service manually:

```bash
# Install dependencies
pip install -r requirements.txt

# Run directly
python3 app.py
```

To manually configure the systemd user service:

```bash
mkdir -p ~/.config/systemd/user/
cp services-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now services-dashboard.service
```

---

## REST API Reference

Services Dashboard provides a clean REST API for automation:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/services` | `GET` | Retrieve cached user services, containers, timers, and ports |
| `/api/scan` | `POST` | Force an immediate rescan of user services and containers |
| `/api/system-tasks` | `GET` | Retrieve system timers, cron jobs, watchers, and failed units |
| `/api/system-tasks/scan` | `POST` | Force an immediate rescan of system tasks |
| `/api/service/{name}/logs` | `GET` | Fetch journalctl logs for a service (`?lines=100&scope=user`) |
| `/api/service/{name}/action` | `POST` | Perform service action (`start`, `stop`, `restart`, `enable`, `disable`) |
| `/api/service/{name}/file` | `GET` | Fetch raw `.service` or `.container` unit file content |
| `/api/service/{name}/file` | `POST` | Save updated unit content with automatic backup creation |
| `/api/system-unit/{name}/cat`| `GET` | Fetch `systemctl cat` unit definition (`?scope=system` or `?scope=user`) |
| `/api/settings` | `GET` / `POST` | Get or update dashboard settings and AppIndex links |
| `/api/status` | `GET` | Health check endpoint returning status and current version |
| `/api/check-update` | `GET` / `POST` | Check for newer releases on GitHub |
| `/api/apply-update` | `POST` | Trigger in-place self-updater and process restart |

---

## Configuration & Architecture

- **Backend**: FastAPI with Uvicorn, querying systemd user session (`systemctl --user`), reading Quadlet container configurations, crontab, and system timers.
- **Frontend**: Single-page application using modern CSS custom properties and native DOM manipulation.
- **Port Mapping**: Discovers ports via `PublishPort=` in Quadlets or regex matching in Exec directives, supplemented by known port defaults in `scanner.py`.
- **Security**: Validated systemd unit names, argument injection safeguards (`--` delimiters), and path traversal guards.

---

## License

MIT License.

---

## Community & Discussions

Got questions, setup ideas, or feedback?

* Join our subreddit at [**r/PlasmaDrifterProjects**](https://reddit.com/r/PlasmaDrifterProjects) to discuss updates, get support, and share configurations.
* Contact directly via email at [**plasmadrifter121@gmail.com**](mailto:plasmadrifter121@gmail.com).
