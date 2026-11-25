import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import scanner

APP_VERSION = "v1.2.5"
GITHUB_REPO = "PlasmaDrifter/Services-dashboard"

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# In-memory cached scan result and concurrency locks
cache_lock = threading.Lock()
services_scan_lock = threading.Lock()
system_scan_lock = threading.Lock()
cached_data: dict[str, Any] | None = None
cached_system_data: dict[str, Any] | None = None
last_services_scan = 0.0
last_system_scan = 0.0
services_scan_seq = 0
system_scan_seq = 0

SERVICES_CACHE_TTL = 10.0   # seconds for user services & containers
SYSTEM_CACHE_TTL = 10.0     # seconds for system tasks & timers
TRANSIENT_CACHE_TTL = 2.0   # seconds when any unit is activating/deactivating
BACKGROUND_SCAN_INTERVAL = 300  # 5 minutes background refresh
STARTUP_SETTLING_DELAY = 4.0    # seconds after startup to re-scan settling units
MAX_CONSECUTIVE_TRANSIENT_SCANS = 5

TRANSIENT_ACTIVE_STATES = frozenset({"activating", "deactivating", "reloading"})
TRANSIENT_SUB_STATES = frozenset({"start-pre", "start-post", "auto-restart", "stop-sigterm", "stop-post"})
TRANSIENT_CONTAINER_STATES = frozenset({"restarting", "created", "removing"})


def has_transient_states(data: dict | None) -> bool:
    if not data or not isinstance(data, dict):
        return False
    for item in data.get("services", []):
        if isinstance(item, dict):
            state = item.get("active_state", "")
            sub = item.get("sub_state", "")
            if state in TRANSIENT_ACTIVE_STATES or sub in TRANSIENT_SUB_STATES:
                return True
    for item in data.get("containers", []):
        if isinstance(item, dict) and str(item.get("state", "")).lower() in TRANSIENT_CONTAINER_STATES:
            return True
    return False


update_cache_lock = threading.Lock()
update_check_inflight_lock = threading.Lock()
UPDATE_CACHE: dict[str, Any] = {
    "last_checked": 0.0,
    "latest_version": APP_VERSION,
    "release_url": f"https://github.com/{GITHUB_REPO}/releases",
    "has_update": False,
}


def parse_version_tuple(v_str: str) -> tuple[tuple[int, ...], int]:
    """
    Parse version string into ((numeric_parts...), stability_rank) where
    final releases rank higher than pre-releases of the same base version.
    """
    if not v_str:
        return (0, 0, 0), 1
    cleaned = re.sub(r"^[vV]", "", str(v_str).strip())
    is_prerelease = 0 if re.search(r"-(?:alpha|beta|rc|dev|pre)", cleaned, re.IGNORECASE) else 1
    base = re.split(r"-(?:alpha|beta|rc|dev|pre)", cleaned, maxsplit=1, flags=re.IGNORECASE)[0]
    parts: list[int] = []
    for p in re.split(r"[-.+_]", base):
        if p.isdigit():
            parts.append(int(p))
        else:
            m = re.match(r"(\d+)", p)
            if m:
                parts.append(int(m.group(1)))
    return tuple(parts or [0]), is_prerelease


def is_newer_version(latest: str, current: str) -> bool:
    try:
        l_parts, l_stable = parse_version_tuple(latest)
        c_parts, c_stable = parse_version_tuple(current)
        max_len = max(len(l_parts), len(c_parts))
        l_padded = l_parts + (0,) * (max_len - len(l_parts))
        c_padded = c_parts + (0,) * (max_len - len(c_parts))
        if l_padded != c_padded:
            return l_padded > c_padded
        return l_stable > c_stable
    except (TypeError, ValueError):
        return False


def validate_appindex_url(url: str) -> str:
    """Validate AppIndex URL uses http:// or https:// with a network host."""
    clean = str(url).strip()
    if not clean:
        return "http://localhost:8765"
    parsed = urllib.parse.urlparse(clean)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise ValueError("AppIndex URL must start with http:// or https:// and include a host")
    return clean


def _load_persisted_update_cache_locked():
    if UPDATE_CACHE["last_checked"] == 0:
        persisted = scanner.get_cached_update()
        if persisted and "last_checked" in persisted:
            UPDATE_CACHE["last_checked"] = persisted.get("last_checked", 0)
            latest_ver = persisted.get("latest_version", APP_VERSION)
            UPDATE_CACHE["latest_version"] = latest_ver
            UPDATE_CACHE["release_url"] = persisted.get(
                "release_url", f"https://github.com/{GITHUB_REPO}/releases"
            )
            UPDATE_CACHE["has_update"] = bool(latest_ver and is_newer_version(latest_ver, APP_VERSION))


def check_github_update(force=False, enabled=True):
    if not enabled:
        return {
            "has_update": False,
            "latest_version": APP_VERSION,
            "release_url": f"https://github.com/{GITHUB_REPO}/releases",
            "current_version": APP_VERSION,
            "check_enabled": False,
        }

    now = time.time()
    with update_cache_lock:
        _load_persisted_update_cache_locked()
        if not force and (now - UPDATE_CACHE["last_checked"] < 3600) and UPDATE_CACHE["last_checked"] > 0:
            cached_has_update = bool(
                UPDATE_CACHE["latest_version"]
                and is_newer_version(UPDATE_CACHE["latest_version"], APP_VERSION)
            )
            return {
                "has_update": cached_has_update,
                "latest_version": UPDATE_CACHE["latest_version"],
                "release_url": UPDATE_CACHE["release_url"],
                "current_version": APP_VERSION,
                "check_enabled": True,
            }

    # Single-flight guard so concurrent callers don't stampede the GitHub API
    with update_check_inflight_lock:
        now = time.time()
        with update_cache_lock:
            _load_persisted_update_cache_locked()
            if not force and (now - UPDATE_CACHE["last_checked"] < 3600) and UPDATE_CACHE["last_checked"] > 0:
                cached_has_update = bool(
                    UPDATE_CACHE["latest_version"]
                    and is_newer_version(UPDATE_CACHE["latest_version"], APP_VERSION)
                )
                return {
                    "has_update": cached_has_update,
                    "latest_version": UPDATE_CACHE["latest_version"],
                    "release_url": UPDATE_CACHE["release_url"],
                    "current_version": APP_VERSION,
                    "check_enabled": True,
                }

        try:
            url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": f"Services-dashboard-UpdateChecker/{APP_VERSION}",
                    "Accept": "application/vnd.github.v3+json",
                },
            )
            with urllib.request.urlopen(req, timeout=4) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            tag = str(data.get("tag_name") or "").strip()
            html_url = data.get("html_url") or f"https://github.com/{GITHUB_REPO}/releases"
            has_update = bool(tag and is_newer_version(tag, APP_VERSION))
            checked_at = time.time()

            cache_payload = {
                "last_checked": checked_at,
                "latest_version": tag or APP_VERSION,
                "release_url": html_url,
                "has_update": has_update,
            }
            with update_cache_lock:
                UPDATE_CACHE.update(cache_payload)

            scanner.set_cached_update(cache_payload)

            return {
                "has_update": has_update,
                "latest_version": tag or APP_VERSION,
                "release_url": html_url,
                "current_version": APP_VERSION,
                "check_enabled": True,
            }
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
            with update_cache_lock:
                # On error, wait 10 min before re-attempting (cooldown = 3600 - 3000 = 600s)
                UPDATE_CACHE["last_checked"] = time.time() - 3000
                cached_has_update = bool(
                    UPDATE_CACHE["latest_version"]
                    and is_newer_version(UPDATE_CACHE["latest_version"], APP_VERSION)
                )
                return {
                    "has_update": cached_has_update,
                    "latest_version": UPDATE_CACHE["latest_version"],
                    "release_url": UPDATE_CACHE["release_url"],
                    "current_version": APP_VERSION,
                    "check_enabled": True,
                    "error": "Failed to check for updates from GitHub.",
                }


def apply_self_update(target_tag: str = "") -> dict:
    """
    Apply self-update using dual-mode strategy:
    1. If .git repository exists, run 'git pull --ff-only' (with fetch/reset fallback if diverged).
    2. If no .git repository (e.g. ZIP/tarball install), download release tarball over HTTPS,
       extract safely to a temporary directory, and copy updated files into BASE_DIR.
    """
    base_dir_str = str(BASE_DIR)
    is_git = os.path.isdir(os.path.join(base_dir_str, ".git"))
    safe_tag = (target_tag or "").strip()

    def _finalize_update(mode: str, message: str, tag: str) -> dict:
        now_ts = time.time()
        final_tag = tag if (tag and tag != "latest") else APP_VERSION
        with update_cache_lock:
            UPDATE_CACHE["has_update"] = False
            UPDATE_CACHE["last_checked"] = now_ts
            if final_tag:
                UPDATE_CACHE["latest_version"] = final_tag
            cache_snapshot = {
                "last_checked": now_ts,
                "latest_version": UPDATE_CACHE["latest_version"],
                "release_url": UPDATE_CACHE["release_url"],
                "has_update": False,
            }
        scanner.set_cached_update(cache_snapshot)
        return {"mode": mode, "message": message, "tag": tag}

    if is_git:
        git_env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        # Check tracked files only so untracked local notes/files don't block updates
        status_check = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            check=False,
            cwd=base_dir_str,
            capture_output=True,
            text=True,
            timeout=10,
            env=git_env,
        )
        if status_check.returncode != 0:
            err_msg = status_check.stderr.strip() or status_check.stdout.strip()
            raise RuntimeError(f"Git status check failed: {err_msg}")
        if status_check.stdout.strip():
            raise RuntimeError(
                "Repository has uncommitted tracked changes; commit or stash them before self-updating."
            )

        res = subprocess.run(
            ["git", "pull", "--ff-only"],
            check=False,
            cwd=base_dir_str,
            capture_output=True,
            text=True,
            timeout=30,
            env=git_env,
        )
        if res.returncode == 0:
            return _finalize_update("git", "Updated via git pull", safe_tag or "latest")

        fetch_res = subprocess.run(
            ["git", "fetch", "--prune", "--tags", "origin"],
            check=False,
            cwd=base_dir_str,
            capture_output=True,
            text=True,
            timeout=30,
            env=git_env,
        )
        if fetch_res.returncode != 0:
            err_msg = fetch_res.stderr.strip() or fetch_res.stdout.strip()
            raise RuntimeError(f"Git fetch failed: {err_msg}")

        branch_res = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            check=False,
            cwd=base_dir_str,
            capture_output=True,
            text=True,
            timeout=10,
            env=git_env,
        )
        current_branch = branch_res.stdout.strip()
        if not current_branch or current_branch == "HEAD":
            head_ref = subprocess.run(
                ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                check=False,
                cwd=base_dir_str,
                capture_output=True,
                text=True,
                timeout=10,
                env=git_env,
            )
            remote_head = head_ref.stdout.strip()
            current_branch = remote_head.removeprefix("origin/") if remote_head else "main"

        reset_res = subprocess.run(
            ["git", "reset", "--hard", f"origin/{current_branch}"],
            check=False,
            cwd=base_dir_str,
            capture_output=True,
            text=True,
            timeout=15,
            env=git_env,
        )
        if reset_res.returncode != 0:
            err_msg = reset_res.stderr.strip() or reset_res.stdout.strip()
            raise RuntimeError(f"Git reset to origin/{current_branch} failed: {err_msg}")

        return _finalize_update(
            "git-reset", f"Synchronized via reset to origin/{current_branch}", safe_tag or "latest"
        )

    if not safe_tag:
        info = check_github_update(force=True)
        if info.get("error"):
            raise RuntimeError(info["error"])
        safe_tag = (info.get("latest_version") or "").strip()
        if not safe_tag:
            raise RuntimeError("Could not determine latest release tag from GitHub.")

    clean_tag = safe_tag if safe_tag.startswith("v") else f"v{safe_tag}"
    candidate_urls = [
        f"https://github.com/{GITHUB_REPO}/archive/refs/tags/{clean_tag}.tar.gz",
    ]
    if safe_tag != clean_tag:
        candidate_urls.append(f"https://github.com/{GITHUB_REPO}/archive/refs/tags/{safe_tag}.tar.gz")

    with tempfile.TemporaryDirectory() as tmp_dir:
        archive_file = os.path.join(tmp_dir, "release.tar.gz")
        extracted_dir = os.path.join(tmp_dir, "extracted")
        os.makedirs(extracted_dir, exist_ok=True)

        downloaded = False
        last_exc: Exception | None = None
        for candidate_url in candidate_urls:
            req = urllib.request.Request(
                candidate_url,
                headers={"User-Agent": f"Services-dashboard-SelfUpdater/{APP_VERSION}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp, open(archive_file, "wb") as f_out:
                    shutil.copyfileobj(resp, f_out)
                downloaded = True
                break
            except urllib.error.HTTPError as exc:
                last_exc = exc
                if exc.code != 404:
                    raise RuntimeError(f"Failed to download release archive ({exc.code}): {exc.reason}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise RuntimeError(f"Failed to download release archive: {exc}") from exc

        if not downloaded:
            raise RuntimeError(f"Release archive not found for tag {safe_tag}: {last_exc}")

        with tarfile.open(archive_file, "r:gz") as tar:
            if hasattr(tarfile, "data_filter"):
                tar.extractall(path=extracted_dir, filter="data")
            else:
                real_extracted = os.path.realpath(extracted_dir)
                for member in tar.getmembers():
                    if member.issym() or member.islnk():
                        raise RuntimeError(f"Security error: archive link not allowed in {member.name}")
                    dest_path = os.path.realpath(os.path.join(real_extracted, member.name))
                    if os.path.commonpath([real_extracted, dest_path]) != real_extracted:
                        raise RuntimeError(f"Security error: path traversal in {member.name}")
                tar.extractall(path=extracted_dir)

        subdirs = [
            os.path.join(extracted_dir, d)
            for d in os.listdir(extracted_dir)
            if os.path.isdir(os.path.join(extracted_dir, d))
        ]
        source_root = subdirs[0] if subdirs else extracted_dir

        for item in os.listdir(source_root):
            if item == "metadata.json":
                continue
            src = os.path.join(source_root, item)
            dst = os.path.join(base_dir_str, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)

        return _finalize_update("archive", f"Updated to {safe_tag} from archive", safe_tag)


def trigger_server_restart():
    """Trigger in-place server restart after giving the response time to flush."""
    def _restart():
        time.sleep(1.0)
        os.execv(sys.executable, [sys.executable] + sys.argv)

    t = threading.Thread(target=_restart, daemon=True)
    t.start()


def _refresh_services_cache(min_age: float | None = None) -> dict[str, Any]:
    """Scan user services/containers outside cache_lock and atomically publish result."""
    global cached_data, last_services_scan, services_scan_seq
    with services_scan_lock:
        if min_age is not None:
            with cache_lock:
                if cached_data is not None and (time.time() - last_services_scan < min_age):
                    return cached_data
        with cache_lock:
            seq_before = services_scan_seq
        new_data = scanner.scan_all()
        now = time.time()
        with cache_lock:
            if services_scan_seq == seq_before:
                cached_data = new_data
                last_services_scan = now
                services_scan_seq += 1
            return cached_data if cached_data is not None else new_data


def _refresh_system_cache(min_age: float | None = None) -> dict[str, Any]:
    """Scan system tasks outside cache_lock and atomically publish result."""
    global cached_system_data, last_system_scan, system_scan_seq
    with system_scan_lock:
        if min_age is not None:
            with cache_lock:
                if cached_system_data is not None and (time.time() - last_system_scan < min_age):
                    return cached_system_data
        with cache_lock:
            seq_before = system_scan_seq
        new_system = scanner.scan_system_tasks()
        now = time.time()
        with cache_lock:
            if system_scan_seq == seq_before:
                cached_system_data = new_system
                last_system_scan = now
                system_scan_seq += 1
            return cached_system_data if cached_system_data is not None else new_system


def run_periodic_scanner(interval_seconds=BACKGROUND_SCAN_INTERVAL, stop_event: threading.Event | None = None):
    transient_streak = 0
    waiter = stop_event.wait if stop_event is not None else time.sleep
    while True:
        if stop_event is not None and stop_event.is_set():
            break
        try:
            with cache_lock:
                is_transient = has_transient_states(cached_data)

            if is_transient and transient_streak < MAX_CONSECUTIVE_TRANSIENT_SCANS:
                transient_streak += 1
                if waiter(3.0):
                    break
                _refresh_services_cache()
                continue

            if not is_transient:
                transient_streak = 0

            if waiter(interval_seconds):
                break
            _refresh_services_cache()
            _refresh_system_cache()
        except Exception as e:
            print("Error in background scan:", e)
            if waiter(interval_seconds):
                break


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop_event = threading.Event()
    _refresh_services_cache()
    _refresh_system_cache()

    def _startup_settling_scan():
        # Automatically re-scan after startup to settle any services
        # still in ExecStartPost or startup initialization at boot.
        if stop_event.wait(STARTUP_SETTLING_DELAY):
            return
        try:
            _refresh_services_cache()
            _refresh_system_cache()
        except Exception as e:
            print("Error in startup settling scan:", e)

    settling_thread = threading.Thread(target=_startup_settling_scan, daemon=True)
    settling_thread.start()

    scanner_thread = threading.Thread(
        target=run_periodic_scanner,
        args=(BACKGROUND_SCAN_INTERVAL, stop_event),
        daemon=True,
    )
    scanner_thread.start()
    try:
        yield
    finally:
        stop_event.set()


app = FastAPI(title="Services-dashboard", lifespan=lifespan)


@app.middleware("http")
async def security_and_csrf_middleware(request: Request, call_next):
    # Block cross-site state-changing browser requests (CSRF / DNS-rebinding defense)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        sec_fetch_site = request.headers.get("sec-fetch-site", "").lower()
        if sec_fetch_site and sec_fetch_site not in ("same-origin", "same-site", "none"):
            return JSONResponse(
                status_code=403,
                content={"detail": "Cross-site state-changing requests are forbidden"},
            )

        origin = request.headers.get("origin")
        if origin:
            origin_host = urllib.parse.urlparse(origin).netloc.lower()
            req_host = (request.headers.get("host") or "").lower()
            if req_host and origin_host != req_host:
                return JSONResponse(status_code=403, content={"detail": "Origin mismatch"})

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


class FileUpdateRequest(BaseModel):
    content: str
    restart: bool = False


class ActionRequest(BaseModel):
    action: str


@app.get("/api/services")
def get_services():
    with cache_lock:
        current = cached_data
        age = time.time() - last_services_scan
    ttl = TRANSIENT_CACHE_TTL if has_transient_states(current) else SERVICES_CACHE_TTL
    if current is not None and age < ttl:
        return current
    return _refresh_services_cache(min_age=ttl)


@app.post("/api/scan")
def trigger_scan():
    try:
        data = _refresh_services_cache()
        return {"status": "ok", "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/service/{name}/file")
def get_file(name: str):
    try:
        safe_name = scanner.validate_unit_name(name)
        content, path = scanner.get_unit_content(safe_name)
        return {"name": safe_name, "file_path": path, "content": content}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/service/{name}/file")
def save_file(name: str, req: FileUpdateRequest):
    try:
        safe_name = scanner.validate_unit_name(name)
        backup_path = scanner.save_unit_content(safe_name, req.content)
        restarted = False
        if req.restart:
            scanner.service_action(safe_name, "restart")
            restarted = True
            time.sleep(0.5)

        _refresh_services_cache()
        return {"status": "saved", "backup": backup_path, "restarted": restarted}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/service/{name}/action")
def perform_action(name: str, req: ActionRequest):
    try:
        safe_name = scanner.validate_unit_name(name)
        scanner.service_action(safe_name, req.action)
        # Short sleep to let systemd state update
        time.sleep(0.5)
        _refresh_services_cache()
        return {"status": "ok", "action": req.action}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/service/{name}/logs")
def get_logs(name: str, lines: int = 100, scope: str = "user"):
    try:
        safe_name = scanner.validate_unit_name(name)
        safe_scope = scanner.validate_scope(scope, default="user")
        lines_count = min(max(int(lines), 1), 1000)
        logs = scanner.get_service_logs(safe_name, lines=lines_count, scope=safe_scope)
        return {"name": safe_name, "scope": safe_scope, "logs": logs}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/system-tasks")
def get_system_tasks():
    with cache_lock:
        current = cached_system_data
        age = time.time() - last_system_scan
    if current is not None and age < SYSTEM_CACHE_TTL:
        return current
    return _refresh_system_cache(min_age=SYSTEM_CACHE_TTL)


@app.post("/api/system-tasks/scan")
def trigger_system_tasks_scan():
    try:
        data = _refresh_system_cache()
        return {"status": "ok", "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/system-unit/{name}/cat")
def get_system_unit_definition(name: str, scope: str = "system"):
    try:
        safe_name = scanner.validate_unit_name(name)
        safe_scope = scanner.validate_scope(scope, default="system")
        content = scanner.get_system_unit_cat(safe_name, scope=safe_scope)
        return {"name": safe_name, "scope": safe_scope, "content": content}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SettingsUpdateRequest(BaseModel):
    show_github_btn: bool | None = None
    check_for_updates: bool | None = None
    show_appindex_link: bool | None = None
    open_appindex_same_tab: bool | None = None
    appindex_url: str | None = None


@app.get("/api/settings")
def get_settings_endpoint():
    try:
        settings = scanner.get_settings()
        update_info = check_github_update(force=False, enabled=settings.get("check_for_updates", True))
        return {
            "status": "ok",
            "settings": settings,
            "update_info": update_info,
            "app_version": APP_VERSION,
            "github_repo": GITHUB_REPO,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/settings")
def update_settings_endpoint(req: SettingsUpdateRequest):
    try:
        updates: dict[str, bool | str] = {}
        if req.show_github_btn is not None:
            updates["show_github_btn"] = req.show_github_btn
        if req.check_for_updates is not None:
            updates["check_for_updates"] = req.check_for_updates
        if req.show_appindex_link is not None:
            updates["show_appindex_link"] = req.show_appindex_link
        if req.open_appindex_same_tab is not None:
            updates["open_appindex_same_tab"] = req.open_appindex_same_tab
        if req.appindex_url is not None:
            updates["appindex_url"] = validate_appindex_url(req.appindex_url)
        new_settings = scanner.update_settings(updates)
        update_info = check_github_update(force=False, enabled=new_settings.get("check_for_updates", True))
        return {
            "status": "ok",
            "settings": new_settings,
            "update_info": update_info,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/status")
def status_api():
    """Health check endpoint."""
    return {"status": "ok", "version": APP_VERSION}


@app.api_route("/api/check-update", methods=["GET", "POST"])
def check_update_endpoint(force: int = 0):
    try:
        update_info = check_github_update(force=bool(force), enabled=True)
        return {
            "status": "ok",
            "update_info": update_info,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/apply-update")
def apply_update_api():
    """Trigger the in-place self-updater and server restart."""
    update_info = check_github_update(force=True)
    if update_info.get("error"):
        raise HTTPException(status_code=502, detail=update_info["error"])
    latest_ver = update_info.get("latest_version") or ""
    try:
        result = apply_self_update(target_tag=latest_ver)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    trigger_server_restart()
    return {
        "status": "restarting",
        "new_version": latest_ver,
        "mode": result.get("mode"),
        "message": result.get("message"),
    }


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.api_route("/favicon.ico", methods=["GET", "HEAD"], include_in_schema=False)
def favicon():
    fav_file = STATIC_DIR / "favicon.ico"
    if fav_file.exists():
        return FileResponse(fav_file)
    raise HTTPException(status_code=404)


@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
def root_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return "<h1>services-dashboard</h1><p>Static files loading...</p>"


if __name__ == "__main__":
    listen_host = os.environ.get("SERVICES_DASHBOARD_HOST", "127.0.0.1")
    listen_port = int(os.environ.get("SERVICES_DASHBOARD_PORT", "5100"))
    uvicorn.run("app:app", host=listen_host, port=listen_port, reload=False, log_level="info")
