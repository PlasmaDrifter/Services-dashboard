import os
import glob
import re
import json
import time
import shutil
import tempfile
import threading
import subprocess
from datetime import datetime
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "systemd" / "user"
QUADLET_DIR = Path.home() / ".config" / "containers" / "systemd"
METADATA_FILE = Path(__file__).resolve().parent / "metadata.json"
metadata_lock = threading.RLock()

KNOWN_PORTS = {
    "mam-bonus-store.service": 5000,
    "flame.service": 5005,
    "flame-organizer.service": 5010,
    "newscurator.service": 5006,
    "github-stats-dashboard.service": 5055,
    "uptime-kuma.service": 3001,
    "uptime-kuma": 3001,
    "filestash.service": 8334,
    "filestash": 8334,
    "jellyfin.service": 8096,
    "jellyfin": 8096,
    "container-jellyfin.service": 8096,
    "container-newscurator.service": 5006,
    "container-degoog.service": 4444,
    "degoog.service": 4444,
    "degoog": 4444,
    "container-audiobookshelf.service": 13378,
    "audiobookshelf": 13378,
    "romcat.service": 8420,
    "system-health-server.service": 9999,
    "beszel.service": 8090,
    "beszel": 8090,
    "services-dashboard.service": 5100,
    "podman-systemd-dashboard.service": 5100,
    "podman-systemd-dashboard": 5100,
    "yt-dlp-server.service": 16800,
    "sunshine.service": 47990
}

def load_metadata():
    with metadata_lock:
        if METADATA_FILE.exists():
            try:
                with open(METADATA_FILE, "r") as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}

def save_metadata(data):
    with metadata_lock:
        try:
            dir_name = METADATA_FILE.parent
            fd, tmp_path = tempfile.mkstemp(prefix="metadata_", suffix=".tmp", dir=str(dir_name))
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp_path, METADATA_FILE)
        except Exception as e:
            print("Error saving metadata:", e)

def get_settings():
    with metadata_lock:
        meta = load_metadata()
        default_settings = {
            "show_github_btn": True,
            "check_for_updates": True,
            "show_appindex_link": False,
            "open_appindex_same_tab": False,
            "appindex_url": "http://localhost:8765"
        }
        saved = meta.get("settings", {})
        return {**default_settings, **saved}

def update_settings(new_settings: dict):
    with metadata_lock:
        meta = load_metadata()
        current = meta.get("settings", {})
        current.update(new_settings)
        meta["settings"] = current
        save_metadata(meta)
        return current

def get_cached_update():
    with metadata_lock:
        meta = load_metadata()
        return meta.get("update_cache", {})

def set_cached_update(update_data: dict):
    with metadata_lock:
        meta = load_metadata()
        meta["update_cache"] = update_data
        save_metadata(meta)

def detect_port_from_content(content):
    matches = re.findall(r'(?:PublishPort|--port|=port|-p|:)\s*=?\s*([0-9]{4,5})', content, re.IGNORECASE)
    if matches:
        for p in matches:
            port_num = int(p)
            if 1024 <= port_num <= 65535:
                return port_num
    return None

def assign_category(name, is_container, has_timer, port):
    if is_container:
        return "Containers"
    if has_timer:
        return "Scheduled Tasks & Timers"
    if port or any(kw in name.lower() for kw in ["web", "dashboard", "kuma", "flame", "store", "catelog", "curator"]):
        return "Web Apps & Dashboards"
    return "Local Utilities & Daemons"

def scan_systemd_units():
    services = {}
    timers = {}
    
    # 1. Scan Podman Quadlets in ~/.config/containers/systemd/
    if QUADLET_DIR.exists():
        for qpath in QUADLET_DIR.glob("*.container"):
            svc_name = f"{qpath.stem}.service"
            services[svc_name] = {
                "name": svc_name,
                "type": "quadlet",
                "file_path": str(qpath),
                "description": "",
                "exec_start": f"Podman Quadlet: {qpath.name}",
                "port": KNOWN_PORTS.get(svc_name),
                "timer": None
            }
            try:
                with open(qpath, "r", errors="ignore") as fp:
                    content = fp.read()
                    for line in content.splitlines():
                        line = line.strip()
                        if line.startswith("Description="):
                            services[svc_name]["description"] = line[12:]
                        elif line.startswith("PublishPort="):
                            port_val = line[12:].split(":")[0].strip()
                            if port_val.isdigit():
                                services[svc_name]["port"] = int(port_val)
                    if not services[svc_name]["port"]:
                        services[svc_name]["port"] = detect_port_from_content(content)
            except Exception as e:
                print(f"Error reading quadlet {qpath}: {e}")

    # 2. Read user unit files in ~/.config/systemd/user
    if CONFIG_DIR.exists():
        for fpath in CONFIG_DIR.glob("*"):
            if fpath.is_file() and not fpath.is_symlink():
                fname = fpath.name
                if fname.endswith(".service"):
                    # Check if this is a superseded legacy container-*.service
                    base_candidate = fname.replace("container-", "")
                    if fname.startswith("container-") and (base_candidate in services):
                        # Skip obsolete container-*.service if quadlet exists
                        continue
                    
                    if fname not in services:
                        services[fname] = {
                            "name": fname,
                            "type": "service",
                            "file_path": str(fpath),
                            "description": "",
                            "exec_start": "",
                            "port": KNOWN_PORTS.get(fname),
                            "timer": None
                        }
                    try:
                        with open(fpath, "r", errors="ignore") as fp:
                            content = fp.read()
                            for line in content.splitlines():
                                line = line.strip()
                                if line.startswith("Description="):
                                    services[fname]["description"] = line[12:]
                                elif line.startswith("ExecStart="):
                                    services[fname]["exec_start"] = line[10:]
                            if not services[fname]["port"]:
                                services[fname]["port"] = detect_port_from_content(content)
                    except Exception as e:
                        print(f"Error reading {fpath}: {e}")
                        
                elif fname.endswith(".timer"):
                    timers[fname] = {
                        "name": fname,
                        "type": "timer",
                        "file_path": str(fpath),
                        "description": "",
                        "schedule": "",
                        "activates": fname.replace(".timer", ".service")
                    }
                    try:
                        with open(fpath, "r", errors="ignore") as fp:
                            content = fp.read()
                            for line in content.splitlines():
                                line = line.strip()
                                if line.startswith("Description="):
                                    timers[fname]["description"] = line[12:]
                                elif line.startswith("OnCalendar="):
                                    timers[fname]["schedule"] = line[11:]
                                elif line.startswith("Unit="):
                                    timers[fname]["activates"] = line[5:]
                    except Exception as e:
                        print(f"Error reading {fpath}: {e}")

    # 3. Correlate timers with services
    for tname, tinfo in timers.items():
        svc_target = tinfo["activates"]
        if svc_target in services:
            services[svc_target]["timer"] = {
                "name": tname,
                "file_path": tinfo["file_path"],
                "schedule": tinfo["schedule"],
                "description": tinfo["description"],
                "next": None,
                "left": None,
                "last": None
            }

    # 4. Query active states via systemctl list-units
    has_systemctl = bool(shutil.which("systemctl"))
    if has_systemctl:
        try:
            p = subprocess.run(
                ["systemctl", "--user", "list-units", "--type=service", "--all", "--output=json"],
                capture_output=True, text=True, timeout=5
            )
            if p.returncode == 0 and p.stdout:
                data = json.loads(p.stdout)
                active_map = {item["unit"]: item for item in data if "unit" in item}
                for sname, sdata in services.items():
                    if sname in active_map:
                        sdata["active_state"] = active_map[sname].get("active", "unknown")
                        sdata["sub_state"] = active_map[sname].get("sub", "unknown")
                        sdata["load_state"] = active_map[sname].get("load", "unknown")
                        if not sdata["description"]:
                            sdata["description"] = active_map[sname].get("description", "")
                    else:
                        sdata["active_state"] = "inactive"
                        sdata["sub_state"] = "dead"
                        sdata["load_state"] = "unloaded"
        except Exception as e:
            print("Error fetching systemctl units:", e)
            for sdata in services.values():
                sdata["active_state"] = "unknown"
                sdata["sub_state"] = "unknown"
    else:
        for sdata in services.values():
            sdata["active_state"] = "unknown"
            sdata["sub_state"] = "unknown"

    # Filter out dead container-*.service if the clean service is running
    keys_to_remove = []
    for sname, sdata in services.items():
        if sname.startswith("container-") and sdata.get("active_state") != "active":
            clean_name = sname.replace("container-", "")
            if clean_name in services and services[clean_name].get("active_state") == "active":
                keys_to_remove.append(sname)
    for k in keys_to_remove:
        services.pop(k, None)

    # 5. Query timer execution status via systemctl list-timers
    if has_systemctl:
        try:
            p = subprocess.run(
                ["systemctl", "--user", "list-timers", "--all", "--output=json"],
                capture_output=True, text=True, timeout=5
            )
            if p.returncode == 0 and p.stdout:
                timers_json = json.loads(p.stdout)
                timer_runtime = {t.get("unit"): t for t in timers_json if "unit" in t}
                for sname, sdata in services.items():
                    if sdata.get("timer"):
                        t_unit = sdata["timer"]["name"]
                        if t_unit in timer_runtime:
                            tr = timer_runtime[t_unit]
                            next_val = tr.get("next")
                            if isinstance(next_val, (int, float)) and next_val > 0:
                                sdata["timer"]["next_str"] = datetime.fromtimestamp(next_val / 1_000_000).strftime("%Y-%m-%d %H:%M:%S")
                            else:
                                sdata["timer"]["next_str"] = str(next_val) if next_val else "n/a"
                            sdata["timer"]["left_str"] = str(tr.get("left", ""))
                            sdata["timer"]["last_str"] = str(tr.get("last", ""))
        except Exception as e:
            print("Error fetching systemctl timers:", e)

    # Assign category
    for sname, sdata in services.items():
        is_container_unit = sdata["type"] == "quadlet" or sname.startswith("container-")
        sdata["category"] = assign_category(sname, is_container_unit, bool(sdata.get("timer")), sdata.get("port"))

    return services, timers

def scan_podman_containers():
    containers = []
    podman_bin = shutil.which("podman")
    if not podman_bin:
        return containers

    try:
        p = subprocess.run(
            [podman_bin, "ps", "-a", "--format", "json"],
            capture_output=True, text=True, timeout=5
        )
        if p.returncode == 0 and p.stdout:
            data = json.loads(p.stdout)
            for item in data:
                cname = item.get("Names", [""])[0] if isinstance(item.get("Names"), list) else str(item.get("Names", ""))
                cname = cname.lstrip("/")
                ports = []
                primary_port = None
                for port_obj in item.get("Ports", []):
                    if isinstance(port_obj, dict):
                        h_port = port_obj.get("host_port")
                        if h_port:
                            ports.append(h_port)
                            if not primary_port:
                                primary_port = h_port
                
                if not primary_port and cname in KNOWN_PORTS:
                    primary_port = KNOWN_PORTS[cname]

                containers.append({
                    "name": cname,
                    "id": item.get("Id", "")[:12],
                    "type": "container",
                    "engine": "podman",
                    "category": "Containers",
                    "state": item.get("State", "").lower(),
                    "status": item.get("Status", ""),
                    "image": item.get("Image", ""),
                    "created": item.get("Created", ""),
                    "ports": ports,
                    "port": primary_port
                })
    except Exception as e:
        print("Error fetching podman containers:", e)
    return containers

def scan_docker_containers():
    containers = []
    docker_bin = shutil.which("docker")
    if not docker_bin:
        return containers

    try:
        p = subprocess.run(
            [docker_bin, "ps", "-a", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=5
        )
        if p.returncode == 0 and p.stdout.strip():
            raw = p.stdout.strip()
            # Handle NDJSON (one JSON per line) or JSON array
            if raw.startswith("["):
                items = json.loads(raw)
            else:
                items = []
                for line in raw.splitlines():
                    line = line.strip()
                    if line:
                        try:
                            items.append(json.loads(line))
                        except Exception:
                            pass

            for item in items:
                raw_name = item.get("Names") or item.get("Name") or ""
                if isinstance(raw_name, list):
                    raw_name = raw_name[0] if raw_name else ""
                cname = str(raw_name).lstrip("/").split(",")[0].strip()
                cid = item.get("ID", item.get("Id", ""))[:12]
                if not cname:
                    cname = cid or "unnamed-container"

                ports_str = item.get("Ports", "")
                ports = []
                primary_port = None
                if isinstance(ports_str, str) and ports_str:
                    # Match published host ports like 0.0.0.0:8080->80/tcp or :::8080->80/tcp
                    for m in re.finditer(r'(?:^|[\s,])(?:(?:\d{1,3}\.){3}\d{1,3}|\[::\]|:::)?(?::)?(\d+)->', ports_str):
                        p_num = int(m.group(1))
                        if p_num not in ports and 1 <= p_num <= 65535:
                            ports.append(p_num)
                            if not primary_port:
                                primary_port = p_num

                if not primary_port and cname in KNOWN_PORTS:
                    primary_port = KNOWN_PORTS[cname]

                state = item.get("State", "").lower()
                status = item.get("Status", "")

                containers.append({
                    "name": cname,
                    "id": cid,
                    "type": "container",
                    "engine": "docker",
                    "category": "Containers",
                    "state": state,
                    "status": status,
                    "image": item.get("Image", ""),
                    "created": item.get("CreatedAt", item.get("Created", "")),
                    "ports": ports,
                    "port": primary_port
                })
    except Exception as e:
        print("Error fetching docker containers:", e)
    return containers

def scan_all():
    services_dict, timers_dict = scan_systemd_units()
    podman_containers = scan_podman_containers()
    docker_containers = scan_docker_containers()
    containers_list = podman_containers + docker_containers
    
    meta = load_metadata()
    for sname, sdata in services_dict.items():
        if sname in meta:
            if "port" in meta[sname]:
                sdata["port"] = meta[sname]["port"]
            if "custom_name" in meta[sname]:
                sdata["custom_name"] = meta[sname]["custom_name"]
            if "category" in meta[sname]:
                sdata["category"] = meta[sname]["category"]

    services_list = sorted(list(services_dict.values()), key=lambda x: x["name"])
    
    running_services = sum(1 for s in services_list if s.get("active_state") == "active")
    running_containers = sum(1 for c in containers_list if c.get("state") == "running")
    active_timers = sum(1 for s in services_list if s.get("timer"))
    web_services = sum(1 for s in services_list if s.get("port")) + sum(1 for c in containers_list if c.get("port"))

    stats = {
        "total_services": len(services_list),
        "running_services": running_services,
        "total_containers": len(containers_list),
        "running_containers": running_containers,
        "podman_containers": len(podman_containers),
        "docker_containers": len(docker_containers),
        "total_timers": len(timers_dict),
        "active_timers": active_timers,
        "web_services": web_services
    }

    return {
        "services": services_list,
        "containers": containers_list,
        "timers": list(timers_dict.values()),
        "stats": stats,
        "last_scan": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }

def get_unit_content(unit_name):
    target = CONFIG_DIR / unit_name
    if not target.exists():
        # Check quadlet
        if unit_name.endswith(".service"):
            qtarget = QUADLET_DIR / f"{unit_name[:-8]}.container"
            if qtarget.exists():
                target = qtarget
    if not target.exists():
        raise FileNotFoundError(f"Unit file not found: {unit_name}")
    with open(target, "r", errors="ignore") as f:
        return f.read(), str(target)

def save_unit_content(unit_name, new_content):
    target = CONFIG_DIR / unit_name
    if not target.exists():
        if unit_name.endswith(".service"):
            qtarget = QUADLET_DIR / f"{unit_name[:-8]}.container"
            if qtarget.exists():
                target = qtarget
    if not target.exists():
        raise FileNotFoundError(f"Unit file not found: {unit_name}")
    
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = target.with_name(f"{target.name}.bak_{ts}")
    shutil.copy2(target, backup_file)
    
    with open(target, "w") as f:
        f.write(new_content)
        
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    return str(backup_file)

def service_action(unit_name, action):
    valid_actions = ["start", "stop", "restart", "enable", "disable"]
    if action not in valid_actions:
        raise ValueError(f"Invalid action: {action}")
    
    if not shutil.which("systemctl"):
        raise RuntimeError("systemctl is not available on this system.")

    res = subprocess.run(
        ["systemctl", "--user", action, unit_name],
        capture_output=True, text=True, timeout=15
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or f"Failed to {action} {unit_name}")
    return True

def get_service_logs(unit_name, lines=100):
    if not shutil.which("journalctl"):
        return "journalctl is not available on this system."

    res = subprocess.run(
        ["journalctl", "--user", "-u", unit_name, "-n", str(lines), "--no-pager"],
        capture_output=True, text=True, timeout=5
    )
    if res.stdout:
        return res.stdout
    if res.stderr and res.returncode != 0:
        return f"Error reading logs: {res.stderr.strip()}"
    return ""
