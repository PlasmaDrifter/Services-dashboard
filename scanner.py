import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "systemd" / "user"
QUADLET_DIR = Path.home() / ".config" / "containers" / "systemd"
METADATA_FILE = Path(__file__).resolve().parent / "metadata.json"
metadata_lock = threading.RLock()

UNIT_NAME_PATTERN = re.compile(r"^(?:-\.(?:mount|slice)|[a-zA-Z0-9_@][a-zA-Z0-9_@.\-:\\]*)$")
VALID_SCOPES = frozenset({"user", "system"})
CRON_ENV_VAR_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*=")
DOCKER_PORT_PATTERN = re.compile(
    r"(?:^|[\s,])(?:(?:\d{1,3}\.){3}\d{1,3}|\[[^\]]*\]|:::)?(?::)?(\d+)(?:-\d+)?->"
)
RESERVED_META_KEYS = frozenset({"settings", "update_cache"})


def validate_unit_name(unit_name: str) -> str:
    """
    Validates a systemd unit name to prevent command/argument injection
    and directory traversal.
    """
    if not isinstance(unit_name, str):
        raise ValueError("Unit name must be a string")
    name = unit_name.strip()
    if not name or len(name) > 256:
        raise ValueError("Invalid unit name length")
    if "/" in name or ".." in name or "\x00" in name:
        raise ValueError("Unit name cannot contain path separators, null bytes, or traversal tokens")
    if not UNIT_NAME_PATTERN.fullmatch(name):
        raise ValueError(f"Invalid unit name: {unit_name}")
    return name


def validate_scope(scope: str | None, default: str = "user") -> str:
    """
    Validates the systemd scope ('user' or 'system').
    """
    if not scope:
        return default
    if not isinstance(scope, str):
        raise ValueError("Scope must be a string")
    clean = scope.strip().lower()
    if clean not in VALID_SCOPES:
        raise ValueError(f"Invalid scope '{scope}': must be 'user' or 'system'")
    return clean


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
    "services-dashboard": 5100,
    "podman-systemd-dashboard.service": 5100,
    "podman-systemd-dashboard": 5100,
    "yt-dlp-server.service": 16800,
    "sunshine.service": 47990,
}


def load_metadata():
    with metadata_lock:
        if METADATA_FILE.exists():
            try:
                with open(METADATA_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data if isinstance(data, dict) else {}
            except (OSError, ValueError):
                return {}
        return {}


def save_metadata(data):
    with metadata_lock:
        tmp_path = None
        try:
            dir_name = METADATA_FILE.parent
            fd, tmp_path = tempfile.mkstemp(prefix="metadata_", suffix=".tmp", dir=str(dir_name))
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp_path, METADATA_FILE)
            tmp_path = None
        except (OSError, TypeError, ValueError) as e:
            print("Error saving metadata:", e)
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


def get_settings():
    with metadata_lock:
        meta = load_metadata()
        default_settings = {
            "show_github_btn": True,
            "check_for_updates": True,
            "show_appindex_link": False,
            "open_appindex_same_tab": False,
            "appindex_url": "http://localhost:8765",
        }
        saved = meta.get("settings", {})
        if not isinstance(saved, dict):
            saved = {}
        return {**default_settings, **saved}


def update_settings(new_settings: dict):
    with metadata_lock:
        meta = load_metadata()
        current = meta.get("settings", {})
        if not isinstance(current, dict):
            current = {}
        current.update(new_settings)
        meta["settings"] = current
        save_metadata(meta)
        return get_settings()


def get_cached_update():
    with metadata_lock:
        meta = load_metadata()
        cache = meta.get("update_cache", {})
        return cache if isinstance(cache, dict) else {}


def set_cached_update(update_data: dict):
    with metadata_lock:
        meta = load_metadata()
        meta["update_cache"] = update_data
        save_metadata(meta)


def _extract_publish_port(value: str) -> int | None:
    """Extract the host port from a Quadlet PublishPort= value."""
    raw = value.strip().split("/", 1)[0].strip()
    if not raw:
        return None
    if raw.startswith("["):
        closing = raw.find("]")
        if closing != -1:
            raw = raw[closing + 1 :].lstrip(":")
    parts = raw.split(":")
    host_part = parts[-2] if len(parts) >= 2 else parts[0]
    host_port = host_part.split("-", 1)[0].strip()
    if host_port.isdigit():
        port_num = int(host_port)
        if 1 <= port_num <= 65535:
            return port_num
    return None


def detect_port_from_content(content: str) -> int | None:
    """Detect a likely web/service listening port from unit or Quadlet file lines."""
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("PublishPort="):
            port_num = _extract_publish_port(line[12:])
            if port_num:
                return port_num

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith(("OnCalendar=", "Image=", "Description=", "Documentation=")):
            continue

        for m in re.finditer(
            r"(?:--port|-p|=port|--listen)\s*=?\s*(?:(?:\d{1,3}\.){3}\d{1,3}:|\[[^\]]*\]:)?(\d{2,5})\b",
            line,
            re.IGNORECASE,
        ):
            port_num = int(m.group(1))
            if port_num in (80, 443) or 1024 <= port_num <= 65535:
                return port_num

        if line.startswith(("ExecStart=", "ExecStartPre=", "ListenStream=", "Environment=")):
            for m in re.finditer(
                r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|PORT\s*=)\s*:?\s*(\d{2,5})\b",
                line,
                re.IGNORECASE,
            ):
                port_num = int(m.group(1))
                if port_num in (80, 443) or 1024 <= port_num <= 65535:
                    return port_num
            for m in re.finditer(r"(?:^|\s):(\d{4,5})\b", line):
                port_num = int(m.group(1))
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


def _run_json_cmd(cmd: list[str], timeout: int = 5):
    """Run a command returning JSON output, or return None on failure."""
    try:
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout)
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as e:
        print(f"Error running {' '.join(cmd[:3])}: {e}")
    return None


def _is_valid_user_unit_file(fpath: Path, root_dir: Path) -> bool:
    """Return True if fpath is a non-masked regular unit file inside root_dir."""
    try:
        if not fpath.is_file():
            return False
        resolved = fpath.resolve()
        if resolved == Path("/dev/null"):
            return False
        return not (fpath.is_symlink() and not resolved.is_relative_to(root_dir.resolve()))
    except OSError:
        return False


def _format_timer_schedule(next_val, last_val, now_ts: float) -> tuple[str, str, str, str]:
    """Format systemd microsecond timer timestamps into display strings."""
    next_str = ""
    left_str = ""
    if isinstance(next_val, (int, float)) and next_val > 0:
        next_sec = next_val / 1_000_000
        next_str = datetime.fromtimestamp(next_sec).strftime("%Y-%m-%d %H:%M:%S")
        left_str = format_relative_left(next_sec - now_ts)

    last_str = ""
    passed_str = ""
    if isinstance(last_val, (int, float)) and last_val > 0:
        last_sec = last_val / 1_000_000
        last_str = datetime.fromtimestamp(last_sec).strftime("%Y-%m-%d %H:%M:%S")
        passed_str = format_relative_passed(now_ts - last_sec)

    return next_str, left_str, last_str, passed_str


def scan_systemd_units():
    services = {}
    timers = {}

    # 1. Scan Podman Quadlets in ~/.config/containers/systemd/
    if QUADLET_DIR.exists():
        for qpath in QUADLET_DIR.glob("*.container"):
            if not _is_valid_user_unit_file(qpath, QUADLET_DIR):
                continue
            svc_name = f"{qpath.stem}.service"
            services[svc_name] = {
                "name": svc_name,
                "type": "quadlet",
                "file_path": str(qpath),
                "description": "",
                "exec_start": f"Podman Quadlet: {qpath.name}",
                "port": None,
                "timer": None,
            }
            try:
                with open(qpath, "r", encoding="utf-8", errors="ignore") as fp:
                    content = fp.read()
                for line in content.splitlines():
                    line = line.strip()
                    if line.startswith("Description="):
                        services[svc_name]["description"] = line[12:]
                    elif line.startswith("PublishPort=") and not services[svc_name]["port"]:
                        services[svc_name]["port"] = _extract_publish_port(line[12:])
                if not services[svc_name]["port"]:
                    services[svc_name]["port"] = detect_port_from_content(content)
            except OSError as e:
                print(f"Error reading quadlet {qpath}: {e}")
            if not services[svc_name]["port"]:
                services[svc_name]["port"] = KNOWN_PORTS.get(svc_name)

    # 2. Read user unit files in ~/.config/systemd/user
    if CONFIG_DIR.exists():
        for fpath in CONFIG_DIR.glob("*"):
            if not _is_valid_user_unit_file(fpath, CONFIG_DIR):
                continue
            fname = fpath.name
            if fname.endswith(".service"):
                base_candidate = fname.removeprefix("container-")
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
                        "port": None,
                        "timer": None,
                    }
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                        content = fp.read()
                    for line in content.splitlines():
                        line = line.strip()
                        if line.startswith("Description="):
                            services[fname]["description"] = line[12:]
                        elif line.startswith("ExecStart="):
                            cmd_val = line[10:].strip()
                            if cmd_val:
                                services[fname]["exec_start"] = cmd_val
                    if not services[fname]["port"]:
                        services[fname]["port"] = detect_port_from_content(content)
                except OSError as e:
                    print(f"Error reading {fpath}: {e}")
                if not services[fname]["port"]:
                    services[fname]["port"] = KNOWN_PORTS.get(fname)

            elif fname.endswith(".timer"):
                timers[fname] = {
                    "name": fname,
                    "type": "timer",
                    "file_path": str(fpath),
                    "description": "",
                    "schedule": "",
                    "activates": f"{fname.removesuffix('.timer')}.service",
                    "active_state": "inactive",
                    "sub_state": "dead",
                }
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                        content = fp.read()
                    for line in content.splitlines():
                        line = line.strip()
                        if line.startswith("Description="):
                            timers[fname]["description"] = line[12:]
                        elif line.startswith("OnCalendar="):
                            timers[fname]["schedule"] = line[11:]
                        elif line.startswith("Unit="):
                            timers[fname]["activates"] = line[5:].strip()
                except OSError as e:
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
                "active_state": "inactive",
                "sub_state": "dead",
                "next": None,
                "left": None,
                "last": None,
                "next_str": "",
                "left_str": "",
                "last_str": "",
                "passed_str": "",
            }

    # 4 & 5. Query service/timer unit states and timer schedules concurrently
    has_systemctl = bool(shutil.which("systemctl"))
    if has_systemctl:
        with ThreadPoolExecutor(max_workers=2) as pool:
            units_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "--user", "list-units", "--type=service,timer", "--all", "--output=json"],
            )
            timers_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "--user", "list-timers", "--all", "--output=json"],
            )
            units_data = units_fut.result()
            timers_json = timers_fut.result()

        if isinstance(units_data, list):
            active_map = {item["unit"]: item for item in units_data if isinstance(item, dict) and "unit" in item}
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

            for tname, tinfo in timers.items():
                if tname in active_map:
                    tinfo["active_state"] = active_map[tname].get("active", "unknown")
                    tinfo["sub_state"] = active_map[tname].get("sub", "unknown")
                    if not tinfo["description"]:
                        tinfo["description"] = active_map[tname].get("description", "")
                target_svc = services.get(tinfo["activates"])
                if target_svc and target_svc.get("timer"):
                    target_svc["timer"]["active_state"] = tinfo["active_state"]
                    target_svc["timer"]["sub_state"] = tinfo["sub_state"]
        else:
            for sdata in services.values():
                sdata["active_state"] = "unknown"
                sdata["sub_state"] = "unknown"

        if isinstance(timers_json, list):
            now_ts = time.time()
            timer_runtime = {t.get("unit"): t for t in timers_json if isinstance(t, dict) and "unit" in t}
            for sdata in services.values():
                if sdata.get("timer"):
                    t_unit = sdata["timer"]["name"]
                    if t_unit in timer_runtime:
                        tr = timer_runtime[t_unit]
                        next_val = tr.get("next")
                        last_val = tr.get("last")
                        next_str, left_str, last_str, passed_str = _format_timer_schedule(next_val, last_val, now_ts)
                        sdata["timer"]["next"] = next_val
                        sdata["timer"]["left"] = tr.get("left")
                        sdata["timer"]["last"] = last_val
                        sdata["timer"]["next_str"] = next_str
                        sdata["timer"]["left_str"] = left_str
                        sdata["timer"]["last_str"] = last_str
                        sdata["timer"]["passed_str"] = passed_str
    else:
        for sdata in services.values():
            sdata["active_state"] = "unknown"
            sdata["sub_state"] = "unknown"

    # Filter out dead container-*.service if the clean service is running
    keys_to_remove = []
    for sname, sdata in services.items():
        if sname.startswith("container-") and sdata.get("active_state") != "active":
            clean_name = sname.removeprefix("container-")
            if clean_name in services and services[clean_name].get("active_state") == "active":
                keys_to_remove.append(sname)
    for k in keys_to_remove:
        services.pop(k, None)

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

    data = _run_json_cmd([podman_bin, "ps", "-a", "--format", "json"])
    if not isinstance(data, list):
        return containers

    for item in data:
        if not isinstance(item, dict):
            continue
        names_val = item.get("Names")
        if isinstance(names_val, list):
            raw_name = names_val[0] if names_val else ""
        else:
            raw_name = names_val or ""
        cname = str(raw_name).lstrip("/")
        cid = str(item.get("Id") or "")[:12]
        if not cname:
            cname = cid or "unnamed-container"

        ports = []
        primary_port = None
        for port_obj in item.get("Ports") or []:
            if isinstance(port_obj, dict):
                h_port = port_obj.get("host_port")
                if h_port and h_port not in ports:
                    ports.append(h_port)
                    if not primary_port:
                        primary_port = h_port

        if not primary_port and cname in KNOWN_PORTS:
            primary_port = KNOWN_PORTS[cname]

        containers.append({
            "name": cname,
            "id": cid,
            "type": "container",
            "engine": "podman",
            "category": "Containers",
            "state": str(item.get("State") or "").lower(),
            "status": str(item.get("Status") or ""),
            "image": str(item.get("Image") or ""),
            "created": str(item.get("Created") or ""),
            "ports": ports,
            "port": primary_port,
        })
    return containers


def scan_docker_containers():
    containers = []
    docker_bin = shutil.which("docker")
    if not docker_bin:
        return containers

    try:
        p = subprocess.run(
            [docker_bin, "ps", "-a", "--format", "{{json .}}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if p.returncode == 0 and p.stdout.strip():
            raw = p.stdout.strip()
            if raw.startswith("["):
                items = json.loads(raw)
            else:
                items = []
                for line in raw.splitlines():
                    line = line.strip()
                    if line:
                        try:
                            items.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass

            for item in items:
                if not isinstance(item, dict):
                    continue
                raw_name = item.get("Names") or item.get("Name") or ""
                if isinstance(raw_name, list):
                    raw_name = raw_name[0] if raw_name else ""
                cname = str(raw_name).lstrip("/").split(",")[0].strip()
                cid = str(item.get("ID") or item.get("Id") or "")[:12]
                if not cname:
                    cname = cid or "unnamed-container"

                ports_str = item.get("Ports") or ""
                ports = []
                primary_port = None
                if isinstance(ports_str, str) and ports_str:
                    for m in DOCKER_PORT_PATTERN.finditer(ports_str):
                        p_num = int(m.group(1))
                        if p_num not in ports and 1 <= p_num <= 65535:
                            ports.append(p_num)
                            if not primary_port:
                                primary_port = p_num

                if not primary_port and cname in KNOWN_PORTS:
                    primary_port = KNOWN_PORTS[cname]

                containers.append({
                    "name": cname,
                    "id": cid,
                    "type": "container",
                    "engine": "docker",
                    "category": "Containers",
                    "state": str(item.get("State") or "").lower(),
                    "status": str(item.get("Status") or ""),
                    "image": str(item.get("Image") or ""),
                    "created": str(item.get("CreatedAt") or item.get("Created") or ""),
                    "ports": ports,
                    "port": primary_port,
                })
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as e:
        print("Error fetching docker containers:", e)
    return containers


def scan_all():
    with ThreadPoolExecutor(max_workers=3) as pool:
        units_fut = pool.submit(scan_systemd_units)
        podman_fut = pool.submit(scan_podman_containers)
        docker_fut = pool.submit(scan_docker_containers)

        services_dict, timers_dict = units_fut.result()
        podman_containers = podman_fut.result()
        docker_containers = docker_fut.result()

    containers_list = podman_containers + docker_containers

    meta = load_metadata()
    for sname, sdata in services_dict.items():
        if sname not in RESERVED_META_KEYS and isinstance(meta.get(sname), dict):
            override = meta[sname]
            if "port" in override:
                sdata["port"] = override["port"]
            if "custom_name" in override:
                sdata["custom_name"] = override["custom_name"]
            if "category" in override:
                sdata["category"] = override["category"]

    services_list = sorted(services_dict.values(), key=lambda x: x["name"])

    running_services = sum(1 for s in services_list if s.get("active_state") == "active")
    running_containers = sum(1 for c in containers_list if c.get("state") == "running")
    active_timers = sum(1 for t in timers_dict.values() if t.get("active_state") == "active")

    # Avoid double-counting containers already matched to a systemd service/quadlet
    container_by_name = {c["name"].lower(): c for c in containers_list if c.get("name")}
    matched_containers = set()
    web_services = 0
    for s in services_list:
        clean_name = s["name"].removesuffix(".service").removeprefix("container-").lower()
        matched = container_by_name.get(clean_name)
        if matched:
            matched_containers.add(matched["name"].lower())
        if s.get("port") or (matched and matched.get("port")):
            web_services += 1
    for c in containers_list:
        cname = (c.get("name") or "").lower()
        if cname not in matched_containers and c.get("port"):
            web_services += 1

    stats = {
        "total_services": len(services_list),
        "running_services": running_services,
        "total_containers": len(containers_list),
        "running_containers": running_containers,
        "podman_containers": len(podman_containers),
        "docker_containers": len(docker_containers),
        "total_timers": len(timers_dict),
        "active_timers": active_timers,
        "web_services": web_services,
    }

    return {
        "services": services_list,
        "containers": containers_list,
        "timers": list(timers_dict.values()),
        "stats": stats,
        "last_scan": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _resolve_unit_file(unit_name: str) -> Path:
    """Resolve and validate the backing unit/quadlet file path for unit_name."""
    unit_name = validate_unit_name(unit_name)
    config_root = CONFIG_DIR.resolve()
    target = (CONFIG_DIR / unit_name).resolve()
    if not target.is_relative_to(config_root):
        raise ValueError("Invalid unit path")
    if not target.exists() and unit_name.endswith(".service"):
        quadlet_root = QUADLET_DIR.resolve()
        qtarget = (QUADLET_DIR / f"{unit_name.removesuffix('.service')}.container").resolve()
        if qtarget.is_relative_to(quadlet_root) and qtarget.exists():
            target = qtarget
    if not target.exists():
        raise FileNotFoundError(f"Unit file not found: {unit_name}")
    return target


def get_unit_content(unit_name):
    target = _resolve_unit_file(unit_name)
    with open(target, "r", encoding="utf-8", errors="ignore") as f:
        return f.read(), str(target)


def save_unit_content(unit_name, new_content):
    target = _resolve_unit_file(unit_name)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = target.with_name(f"{target.name}.bak_{ts}")
    counter = 1
    while backup_file.exists():
        backup_file = target.with_name(f"{target.name}.bak_{ts}_{counter}")
        counter += 1
    shutil.copy2(target, backup_file)

    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(new_content)
        shutil.copymode(target, tmp_path)
        os.replace(tmp_path, target)
        tmp_path = None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if shutil.which("systemctl"):
        subprocess.run(
            ["systemctl", "--user", "daemon-reload"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    return str(backup_file)


def service_action(unit_name, action):
    valid_actions = ["start", "stop", "restart", "enable", "disable"]
    if action not in valid_actions:
        raise ValueError(f"Invalid action: {action}")

    safe_unit = validate_unit_name(unit_name)

    if not shutil.which("systemctl"):
        raise RuntimeError("systemctl is not available on this system.")

    res = subprocess.run(
        ["systemctl", "--user", action, "--", safe_unit],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or f"Failed to {action} {safe_unit}")
    return True


def get_service_logs(unit_name, lines=100, scope="user"):
    if not shutil.which("journalctl"):
        return "journalctl is not available on this system."

    safe_unit = validate_unit_name(unit_name)
    safe_scope = validate_scope(scope, default="user")

    cmd = ["journalctl"]
    if safe_scope == "user":
        cmd.append("--user")
    cmd.extend(["--unit", safe_unit, "-n", str(lines), "--no-pager", "--"])

    res = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=5)
    if res.stdout:
        return res.stdout
    if res.stderr and res.returncode != 0:
        return f"Error reading logs: {res.stderr.strip()}"
    return ""


def format_relative_left(seconds: float) -> str:
    if seconds is None:
        return ""
    if seconds < 0:
        return "passed"
    secs = int(seconds)
    if secs < 60:
        return f"{secs}s left"
    mins = secs // 60
    if mins < 60:
        return f"{mins}min left"
    hours = mins // 60
    if hours < 24:
        rem_mins = mins % 60
        return f"{hours}h {rem_mins}m left"
    days = hours // 24
    rem_h = hours % 24
    return f"{days}d {rem_h}h left"


def format_relative_passed(seconds: float) -> str:
    if seconds is None or seconds <= 0:
        return ""
    secs = int(seconds)
    if secs < 60:
        return f"{secs}s ago"
    mins = secs // 60
    if mins < 60:
        return f"{mins}min ago"
    hours = mins // 60
    if hours < 24:
        rem_m = mins % 60
        return f"{hours}h {rem_m}m ago"
    days = hours // 24
    rem_h = hours % 24
    return f"{days}d {rem_h}h ago"


def _build_system_timers(timer_units_map: dict, timers_json: list | None) -> list[dict]:
    timers_list: list[dict] = []
    if not isinstance(timers_json, list):
        return timers_list

    now_ts = time.time()
    for t in timers_json:
        if not isinstance(t, dict):
            continue
        unit_name = t.get("unit")
        if not unit_name:
            continue

        activates = t.get("activates", f"{unit_name.removesuffix('.timer')}.service")
        unit_info = timer_units_map.get(unit_name, {})
        desc = unit_info.get("description", "")

        next_str, left_str, last_str, passed_str = _format_timer_schedule(t.get("next"), t.get("last"), now_ts)

        timers_list.append({
            "name": unit_name,
            "type": "timer",
            "scope": "system",
            "activates": activates,
            "description": desc or f"System maintenance timer: {unit_name}",
            "active_state": unit_info.get("active", "active"),
            "sub_state": unit_info.get("sub", "waiting"),
            "next_str": next_str,
            "left_str": left_str,
            "last_str": last_str,
            "passed_str": passed_str,
        })

    return sorted(timers_list, key=lambda x: x["name"])


def scan_system_timers():
    """
    Scans system-level systemd timers via `systemctl list-timers --all --output=json`
    and correlates them with unit descriptions.
    """
    if not shutil.which("systemctl"):
        return []

    with ThreadPoolExecutor(max_workers=2) as pool:
        units_fut = pool.submit(_run_json_cmd, ["systemctl", "list-units", "--type=timer", "--all", "--output=json"])
        timers_fut = pool.submit(_run_json_cmd, ["systemctl", "list-timers", "--all", "--output=json"])
        units_data = units_fut.result()
        timers_json = timers_fut.result()

    timer_units = {}
    if isinstance(units_data, list):
        for item in units_data:
            if isinstance(item, dict) and item.get("unit"):
                timer_units[item["unit"]] = item
    return _build_system_timers(timer_units, timers_json)


def scan_cron_jobs(cron_dirs=None):
    """
    Scans user crontab (`crontab -l`) and system cron directories (`/etc/cron.*`).
    """
    cron_items = []

    # 1. User crontab
    if shutil.which("crontab"):
        try:
            p = subprocess.run(["crontab", "-l"], check=False, capture_output=True, text=True, timeout=5)
            if p.returncode == 0 and p.stdout:
                for line_idx, raw_line in enumerate(p.stdout.splitlines(), start=1):
                    line = raw_line.strip()
                    if not line or line.startswith("#") or CRON_ENV_VAR_PATTERN.match(line):
                        continue

                    if line.startswith("@"):
                        parts = line.split(maxsplit=1)
                        schedule = parts[0]
                        command = parts[1] if len(parts) > 1 else ""
                    else:
                        parts = line.split()
                        if len(parts) >= 6:
                            schedule = " ".join(parts[:5])
                            command = " ".join(parts[5:])
                        else:
                            schedule = "custom"
                            command = line

                    cron_items.append({
                        "name": f"User Crontab (line {line_idx})",
                        "scope": "user",
                        "type": "cron",
                        "source": "crontab -l",
                        "schedule": schedule,
                        "command": command,
                        "description": f"User scheduled cron job: {command[:60]}",
                        "edit_cmd": "crontab -e",
                    })
        except (subprocess.SubprocessError, OSError) as e:
            print("Error reading user crontab:", e)

    # 2. System cron directories
    if cron_dirs is None:
        cron_dirs = [
            ("/etc/cron.hourly", "Hourly (@hourly)"),
            ("/etc/cron.daily", "Daily (@daily)"),
            ("/etc/cron.weekly", "Weekly (@weekly)"),
            ("/etc/cron.monthly", "Monthly (@monthly)"),
            ("/etc/cron.d", "Custom Cron Definition"),
        ]

    for cdir_path, default_sched in cron_dirs:
        cdir = Path(cdir_path)
        if cdir.exists() and cdir.is_dir():
            try:
                for entry in sorted(cdir.iterdir(), key=lambda p: p.name):
                    if entry.is_file() and not entry.name.startswith("."):
                        if default_sched == "Custom Cron Definition" or str(cdir) == "/etc/cron.d":
                            try:
                                with open(entry, "r", encoding="utf-8", errors="ignore") as f:
                                    for l_idx, line in enumerate(f, start=1):
                                        sline = line.strip()
                                        if not sline or sline.startswith("#") or CRON_ENV_VAR_PATTERN.match(sline):
                                            continue
                                        parts = sline.split()
                                        if parts[0].startswith("@") and len(parts) >= 3:
                                            sched = parts[0]
                                            user = parts[1]
                                            cmd = " ".join(parts[2:])
                                        elif len(parts) >= 7:
                                            sched = " ".join(parts[:5])
                                            user = parts[5]
                                            cmd = " ".join(parts[6:])
                                        else:
                                            continue
                                        cron_items.append({
                                            "name": f"{entry.name} ({l_idx})",
                                            "scope": "system",
                                            "type": "cron",
                                            "source": str(entry),
                                            "schedule": sched,
                                            "command": f"[{user}] {cmd}",
                                            "description": f"System cron job in {entry.name}",
                                            "edit_cmd": f"sudo nano {entry}",
                                        })
                            except OSError:
                                pass
                        else:
                            cron_items.append({
                                "name": entry.name,
                                "scope": "system",
                                "type": "cron",
                                "source": str(entry),
                                "schedule": default_sched,
                                "command": str(entry),
                                "description": f"System maintenance script in {cdir.name}",
                                "edit_cmd": f"sudo nano {entry}",
                            })
            except OSError as e:
                print(f"Error reading cron directory {cdir}: {e}")

    return cron_items


def _parse_failed_units(items: list | None, scope: str) -> list[dict]:
    failed_items: list[dict] = []
    if not isinstance(items, list):
        return failed_items
    default_desc = f"Failed {scope} unit"
    for item in items:
        if not isinstance(item, dict):
            continue
        u = item.get("unit")
        if u:
            failed_items.append({
                "name": u,
                "display_name": u.replace("\\x2d", "-"),
                "scope": scope,
                "active": item.get("active", "failed"),
                "sub": item.get("sub", "failed"),
                "description": item.get("description", default_desc),
            })
    return failed_items


def scan_failed_units():
    """
    Scans for failed/degraded units across system and user scopes.
    """
    if not shutil.which("systemctl"):
        return []

    with ThreadPoolExecutor(max_workers=2) as pool:
        sys_fut = pool.submit(_run_json_cmd, ["systemctl", "list-units", "--state=failed", "--output=json"])
        usr_fut = pool.submit(_run_json_cmd, ["systemctl", "--user", "list-units", "--state=failed", "--output=json"])
        sys_data = sys_fut.result()
        usr_data = usr_fut.result()

    return _parse_failed_units(sys_data, "system") + _parse_failed_units(usr_data, "user")


def _parse_watchers(items: list | None, scope: str) -> list[dict]:
    watchers: list[dict] = []
    if not isinstance(items, list):
        return watchers
    for item in items:
        if not isinstance(item, dict):
            continue
        u = item.get("unit")
        if not u:
            continue
        unit_type = "path" if u.endswith(".path") else "socket"
        watchers.append({
            "name": u,
            "display_name": u.replace("\\x2d", "-"),
            "scope": scope,
            "type": unit_type,
            "active_state": item.get("active", "active"),
            "sub_state": item.get("sub", "waiting"),
            "description": item.get("description", f"{unit_type.capitalize()} unit"),
        })
    return watchers


def scan_watchers_and_sockets():
    """
    Scans system and user path units (*.path) and socket units (*.socket).
    """
    if not shutil.which("systemctl"):
        return []

    with ThreadPoolExecutor(max_workers=2) as pool:
        sys_fut = pool.submit(
            _run_json_cmd,
            ["systemctl", "list-units", "--type=path,socket", "--all", "--output=json"],
        )
        usr_fut = pool.submit(
            _run_json_cmd,
            ["systemctl", "--user", "list-units", "--type=path,socket", "--all", "--output=json"],
        )
        sys_data = sys_fut.result()
        usr_data = usr_fut.result()

    return _parse_watchers(sys_data, "system") + _parse_watchers(usr_data, "user")


def scan_system_tasks():
    """
    Aggregates all system-level timers, cron jobs, watchers, and health statuses.
    """
    has_systemctl = bool(shutil.which("systemctl"))
    if has_systemctl:
        with ThreadPoolExecutor(max_workers=6) as pool:
            sys_units_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "list-units", "--type=timer,path,socket", "--all", "--output=json"],
            )
            sys_timers_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "list-timers", "--all", "--output=json"],
            )
            usr_watchers_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "--user", "list-units", "--type=path,socket", "--all", "--output=json"],
            )
            sys_failed_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "list-units", "--state=failed", "--output=json"],
            )
            usr_failed_fut = pool.submit(
                _run_json_cmd,
                ["systemctl", "--user", "list-units", "--state=failed", "--output=json"],
            )
            cron_fut = pool.submit(scan_cron_jobs)

            sys_units_data = sys_units_fut.result() or []
            sys_timers_json = sys_timers_fut.result()
            usr_watchers_data = usr_watchers_fut.result()
            sys_failed_data = sys_failed_fut.result()
            usr_failed_data = usr_failed_fut.result()
            cron_jobs = cron_fut.result()

        timer_units_map = {}
        sys_watcher_items = []
        if isinstance(sys_units_data, list):
            for item in sys_units_data:
                if not isinstance(item, dict):
                    continue
                uname = item.get("unit", "")
                if uname.endswith(".timer"):
                    timer_units_map[uname] = item
                elif uname.endswith((".path", ".socket")):
                    sys_watcher_items.append(item)

        system_timers = _build_system_timers(timer_units_map, sys_timers_json)
        watchers = _parse_watchers(sys_watcher_items, "system") + _parse_watchers(usr_watchers_data, "user")
        failed_units = _parse_failed_units(sys_failed_data, "system") + _parse_failed_units(usr_failed_data, "user")
    else:
        system_timers = []
        watchers = []
        failed_units = []
        cron_jobs = scan_cron_jobs()

    active_system_timers = sum(1 for t in system_timers if t.get("active_state") == "active")

    stats = {
        "total_system_timers": len(system_timers),
        "active_system_timers": active_system_timers,
        "total_cron_jobs": len(cron_jobs),
        "total_watchers": len(watchers),
        "failed_units_count": len(failed_units),
        "is_healthy": len(failed_units) == 0,
    }

    return {
        "system_timers": system_timers,
        "cron_jobs": cron_jobs,
        "watchers": watchers,
        "failed_units": failed_units,
        "stats": stats,
        "last_scan": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_system_unit_cat(unit_name: str, scope: str = "system"):
    """
    Fetches the raw unit file definition via `systemctl cat`.
    """
    if not shutil.which("systemctl"):
        return "systemctl is not available on this system."

    safe_unit = validate_unit_name(unit_name)
    safe_scope = validate_scope(scope, default="system")

    cmd = ["systemctl"]
    if safe_scope == "user":
        cmd.append("--user")
    cmd.extend(["cat", "--", safe_unit])

    res = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=5)
    if res.stdout:
        return res.stdout
    if res.stderr:
        return f"Error reading unit: {res.stderr.strip()}"
    return "No unit definition available."
