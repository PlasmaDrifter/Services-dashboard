import io
import json
import os
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

import app
import scanner


class TestUpdaterEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app)

    def test_status_endpoint(self):
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("version"), app.APP_VERSION)

    def test_check_update_endpoint(self):
        with patch(
            "app.check_github_update",
            return_value={
                "has_update": False,
                "latest_version": app.APP_VERSION,
                "release_url": f"https://github.com/{app.GITHUB_REPO}/releases",
                "current_version": app.APP_VERSION,
                "check_enabled": True,
            },
        ) as mock_check:
            response = self.client.get("/api/check-update")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data.get("status"), "ok")
            self.assertIn("update_info", data)
            mock_check.assert_called_once_with(force=False, enabled=True)

    def test_logs_endpoint(self):
        with patch("scanner.get_service_logs") as mock_logs:
            mock_logs.return_value = "Sep 25 12:00:00 service started"
            response = self.client.get("/api/service/test.service/logs?lines=50")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data.get("name"), "test.service")
            self.assertEqual(data.get("logs"), "Sep 25 12:00:00 service started")
            mock_logs.assert_called_once_with("test.service", lines=50, scope="user")

    def test_apply_update_endpoint(self):
        with patch(
            "app.check_github_update",
            return_value={"has_update": True, "latest_version": "v1.2.6"},
        ), patch("app.apply_self_update") as mock_apply, patch(
            "app.trigger_server_restart"
        ) as mock_restart:
            mock_apply.return_value = {
                "mode": "git",
                "message": "Updated via git pull",
                "tag": "v1.2.6",
            }
            response = self.client.post("/api/apply-update")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data.get("status"), "restarting")
            self.assertEqual(data.get("mode"), "git")
            mock_apply.assert_called_once_with(target_tag="v1.2.6")
            mock_restart.assert_called_once()

    def test_apply_update_aborts_when_check_fails(self):
        with patch(
            "app.check_github_update",
            return_value={
                "has_update": False,
                "latest_version": app.APP_VERSION,
                "error": "Failed to check for updates from GitHub.",
            },
        ), patch("app.apply_self_update") as mock_apply:
            response = self.client.post("/api/apply-update")
            self.assertEqual(response.status_code, 502)
            mock_apply.assert_not_called()

    def test_safe_archive_extraction(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            tar_path = os.path.join(temp_dir, "sample.tar.gz")
            with tarfile.open(tar_path, "w:gz") as tar:
                content = b"print('updated')\n"
                info = tarfile.TarInfo(name="Services-dashboard-1.2.5/test_file.py")
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))

            dest_dir = os.path.join(temp_dir, "extracted")
            os.makedirs(dest_dir, exist_ok=True)
            with tarfile.open(tar_path, "r:gz") as tar:
                if hasattr(tarfile, "data_filter"):
                    tar.extractall(path=dest_dir, filter="data")
                else:
                    tar.extractall(path=dest_dir)

            extracted_file = os.path.join(dest_dir, "Services-dashboard-1.2.5", "test_file.py")
            self.assertTrue(os.path.isfile(extracted_file))
            with open(extracted_file, "r", encoding="utf-8") as f:
                self.assertIn("updated", f.read())

    def test_scan_docker_containers(self):
        mock_ndjson = (
            '{"ID":"e1f2a3b4c5d6","Names":"/my-web-app","Image":"nginx:alpine",'
            '"State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:8088->80/tcp, :::8088->80/tcp"}\n'
            '{"ID":"1234567890ab","Names":"worker-task","Image":"redis:alpine",'
            '"State":"exited","Status":"Exited (0) 10 minutes ago","Ports":""}\n'
            '{"ID":"abcdef123456","Names":"ipv6-range","Image":"caddy:alpine",'
            '"State":"running","Status":"Up 5 minutes","Ports":"[::1]:9000-9002->80-82/tcp"}\n'
        )

        with patch("shutil.which", return_value="/usr/bin/docker"), patch("subprocess.run") as mock_run:
            mock_proc = MagicMock()
            mock_proc.returncode = 0
            mock_proc.stdout = mock_ndjson
            mock_run.return_value = mock_proc

            containers = scanner.scan_docker_containers()
            self.assertEqual(len(containers), 3)

            c1 = containers[0]
            self.assertEqual(c1["name"], "my-web-app")
            self.assertEqual(c1["id"], "e1f2a3b4c5d6")
            self.assertEqual(c1["engine"], "docker")
            self.assertEqual(c1["state"], "running")
            self.assertEqual(c1["port"], 8088)
            self.assertIn(8088, c1["ports"])

            c2 = containers[1]
            self.assertEqual(c2["name"], "worker-task")
            self.assertEqual(c2["engine"], "docker")
            self.assertEqual(c2["state"], "exited")
            self.assertIsNone(c2["port"])

            c3 = containers[2]
            self.assertEqual(c3["name"], "ipv6-range")
            self.assertEqual(c3["port"], 9000)

    def test_scan_podman_containers_null_ports_and_empty_names(self):
        podman_json = json.dumps([
            {
                "Id": "abc123456789def",
                "Names": ["web-app"],
                "State": "running",
                "Status": "Up 1 hour",
                "Image": "nginx:latest",
                "Ports": None,
            },
            {
                "Id": "deadbeef12345678",
                "Names": [],
                "State": None,
                "Status": None,
                "Image": "busybox",
                "Ports": [{"host_port": 8081}],
            },
        ])
        with patch("shutil.which", return_value="/usr/bin/podman"), patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=podman_json)
            containers = scanner.scan_podman_containers()
            self.assertEqual(len(containers), 2)
            self.assertEqual(containers[0]["name"], "web-app")
            self.assertEqual(containers[0]["ports"], [])
            self.assertEqual(containers[1]["name"], "deadbeef1234")
            self.assertEqual(containers[1]["port"], 8081)

    def test_scan_all_container_stats_and_web_dedup(self):
        fake_services = {
            "flame.service": {
                "name": "flame.service",
                "type": "quadlet",
                "port": 5005,
                "active_state": "active",
            }
        }
        fake_timers = {
            "backup.timer": {"name": "backup.timer", "active_state": "active"},
            "idle.timer": {"name": "idle.timer", "active_state": "inactive"},
        }
        fake_podman = [{"name": "flame", "state": "running", "port": 5005, "engine": "podman"}]
        fake_docker = [{"name": "d1", "state": "running", "port": 8080, "engine": "docker"}]

        with patch("scanner.scan_systemd_units", return_value=(fake_services, fake_timers)), patch(
            "scanner.scan_podman_containers", return_value=fake_podman
        ), patch("scanner.scan_docker_containers", return_value=fake_docker):
            res = scanner.scan_all()
            stats = res["stats"]
            self.assertEqual(stats["total_containers"], 2)
            self.assertEqual(stats["podman_containers"], 1)
            self.assertEqual(stats["docker_containers"], 1)
            self.assertEqual(stats["running_containers"], 2)
            self.assertEqual(stats["total_timers"], 2)
            self.assertEqual(stats["active_timers"], 1)
            # flame.service + flame container deduplicated into 1 web service, plus d1 = 2
            self.assertEqual(stats["web_services"], 2)

    def test_version_comparison(self):
        self.assertTrue(app.is_newer_version("v1.1.5", "v1.1.4"))
        self.assertTrue(app.is_newer_version("1.2.2", "1.2.1"))
        self.assertFalse(app.is_newer_version("v1.1.5", "v1.1.5"))
        self.assertFalse(app.is_newer_version("v1.1.4", "v1.1.5"))
        self.assertFalse(app.is_newer_version("1.0.0", "1.1.0"))
        # Zero-padding & pre-release handling
        self.assertFalse(app.is_newer_version("v1.2.0", "v1.2"))
        self.assertFalse(app.is_newer_version("v1.2.5-rc1", "v1.2.5"))
        self.assertTrue(app.is_newer_version("v1.2.5", "v1.2.5-rc1"))

    def test_stale_cache_evaluated_against_current_version(self):
        stale_meta = {
            "last_checked": time.time() - 300,
            "latest_version": app.APP_VERSION,
            "release_url": f"https://github.com/{app.GITHUB_REPO}/releases/tag/{app.APP_VERSION}",
            "has_update": True,
        }

        with patch("scanner.get_cached_update", return_value=stale_meta):
            with app.update_cache_lock:
                app.UPDATE_CACHE["last_checked"] = 0
                app.UPDATE_CACHE["latest_version"] = app.APP_VERSION
                app.UPDATE_CACHE["has_update"] = True

            result = app.check_github_update(force=False, enabled=True)
            self.assertFalse(
                result["has_update"],
                "has_update must be False when latest_version matches current_version, even if cached as True",
            )

    def test_apply_update_clears_update_cache(self):
        with patch("subprocess.run") as mock_run, patch(
            "scanner.set_cached_update"
        ) as mock_set_cache, patch("os.path.isdir", return_value=True):
            mock_proc = MagicMock(returncode=0, stdout="", stderr="")
            mock_run.return_value = mock_proc

            app.UPDATE_CACHE["has_update"] = True
            app.apply_self_update(target_tag=app.APP_VERSION)

            self.assertFalse(app.UPDATE_CACHE["has_update"])
            mock_set_cache.assert_called_once()
            saved = mock_set_cache.call_args[0][0]
            self.assertFalse(saved["has_update"])
            # Confirm untracked files do not hijack pull
            first_cmd = mock_run.call_args_list[0][0][0]
            self.assertIn("--untracked-files=no", first_cmd)

    def test_apply_update_rejects_dirty_tracked_tree(self):
        with patch("subprocess.run") as mock_run, patch("os.path.isdir", return_value=True):
            mock_run.return_value = MagicMock(returncode=0, stdout=" M app.py\n", stderr="")
            with self.assertRaises(RuntimeError) as ctx:
                app.apply_self_update(target_tag="v1.2.6")
            self.assertIn("uncommitted tracked changes", str(ctx.exception))

    def test_apply_update_git_diverged_fallback(self):
        p_status = MagicMock(returncode=0, stdout="", stderr="")
        p_pull = MagicMock(returncode=128, stdout="", stderr="fatal: Not possible to fast-forward, aborting.")
        p_fetch = MagicMock(returncode=0, stdout="", stderr="")
        p_branch = MagicMock(returncode=0, stdout="main\n", stderr="")
        p_reset = MagicMock(returncode=0, stdout="HEAD is now at 1234abc", stderr="")

        with patch("subprocess.run", side_effect=[p_status, p_pull, p_fetch, p_branch, p_reset]) as mock_run, patch(
            "scanner.set_cached_update"
        ), patch("os.path.isdir", return_value=True):
            app.UPDATE_CACHE["has_update"] = True
            result = app.apply_self_update(target_tag="v1.1.9")

            self.assertEqual(result["mode"], "git-reset")
            self.assertIn("Synchronized via reset to origin/main", result["message"])
            self.assertFalse(app.UPDATE_CACHE["has_update"])
            self.assertEqual(mock_run.call_count, 5)

    def test_settings_endpoints_and_url_validation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            test_meta_file = Path(temp_dir) / "metadata.json"
            with patch.object(scanner, "METADATA_FILE", test_meta_file), patch(
                "app.check_github_update",
                return_value={"has_update": False, "latest_version": app.APP_VERSION},
            ):
                res = self.client.get("/api/settings")
                self.assertEqual(res.status_code, 200)
                data = res.json()
                self.assertEqual(data.get("status"), "ok")
                self.assertFalse(data["settings"]["show_appindex_link"])

                post_res = self.client.post(
                    "/api/settings",
                    json={"show_appindex_link": True, "open_appindex_same_tab": True},
                )
                self.assertEqual(post_res.status_code, 200)
                post_data = post_res.json()
                self.assertTrue(post_data["settings"]["show_appindex_link"])
                self.assertTrue(post_data["settings"]["open_appindex_same_tab"])

                bad_res = self.client.post(
                    "/api/settings",
                    json={"appindex_url": "javascript:alert(1)"},
                )
                self.assertEqual(bad_res.status_code, 400)

                verify_res = self.client.get("/api/settings")
                self.assertEqual(verify_res.status_code, 200)
                self.assertTrue(verify_res.json()["settings"]["show_appindex_link"])

    def test_csrf_middleware_blocks_cross_site_post(self):
        res = self.client.post(
            "/api/scan",
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(res.status_code, 403)

    def test_system_tasks_endpoints(self):
        fake_tasks = {
            "system_timers": [{"name": "fstrim.timer", "scope": "system"}],
            "cron_jobs": [{"name": "daily", "scope": "system"}],
            "watchers": [{"name": "test.socket", "scope": "system"}],
            "failed_units": [],
            "stats": {"total_system_timers": 1, "is_healthy": True},
        }
        with app.cache_lock:
            app.cached_system_data = None
            app.last_system_scan = 0.0

        with patch("scanner.scan_system_tasks", return_value=fake_tasks), patch(
            "scanner.get_system_unit_cat", return_value="[Unit]\nDescription=Test Timer"
        ):
            res = self.client.get("/api/system-tasks")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(len(data["system_timers"]), 1)
            self.assertTrue(data["stats"]["is_healthy"])

            scan_res = self.client.post("/api/system-tasks/scan")
            self.assertEqual(scan_res.status_code, 200)
            scan_data = scan_res.json()
            self.assertEqual(scan_data["status"], "ok")
            self.assertEqual(len(scan_data["data"]["system_timers"]), 1)

            cat_res = self.client.get("/api/system-unit/fstrim.timer/cat?scope=system")
            self.assertEqual(cat_res.status_code, 200)
            cat_data = cat_res.json()
            self.assertEqual(cat_data["name"], "fstrim.timer")
            self.assertIn("Description=Test Timer", cat_data["content"])

    def test_cron_jobs_parsing_env_vars_and_crond_specials(self):
        mock_crontab_out = (
            "SHELL=/bin/bash\n"
            "MAILTO=admin@example.com\n"
            "0 3 * * * /usr/local/bin/backup.sh\n"
            "@reboot /usr/local/bin/startup.sh\n"
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            cron_d_dir = Path(tmp_dir)
            (cron_d_dir / "custom").write_text(
                "PATH=/usr/bin:/bin\n@reboot root /usr/bin/init-task\n0 * * * * root /usr/bin/hourly-task\n",
                encoding="utf-8",
            )
            with patch("shutil.which", return_value="/usr/bin/crontab"), patch(
                "subprocess.run", return_value=MagicMock(returncode=0, stdout=mock_crontab_out)
            ):
                jobs = scanner.scan_cron_jobs(cron_dirs=[(str(cron_d_dir), "Custom Cron Definition")])
                user_jobs = [j for j in jobs if j.get("scope") == "user"]
                sys_jobs = [j for j in jobs if j.get("scope") == "system"]
                self.assertEqual(len(user_jobs), 2)
                self.assertEqual(user_jobs[0]["schedule"], "0 3 * * *")
                self.assertEqual(user_jobs[1]["schedule"], "@reboot")
                self.assertEqual(user_jobs[0]["edit_cmd"], "crontab -e")
                self.assertEqual(len(sys_jobs), 2)
                self.assertEqual(sys_jobs[0]["schedule"], "@reboot")
                self.assertEqual(sys_jobs[0]["command"], "[root] /usr/bin/init-task")
                self.assertEqual(sys_jobs[1]["schedule"], "0 * * * *")

    def test_user_timer_formatting_and_quadlet_ports(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            cfg_dir = tmp_path / "systemd_user"
            quad_dir = tmp_path / "containers_systemd"
            cfg_dir.mkdir()
            quad_dir.mkdir()

            (quad_dir / "flame.container").write_text(
                "[Container]\nPublishPort=127.0.0.1:5050:5005/tcp\n",
                encoding="utf-8",
            )
            (cfg_dir / "daily-job.service").write_text(
                "[Service]\nExecStart=/bin/true\n",
                encoding="utf-8",
            )
            (cfg_dir / "daily-job.timer").write_text(
                "[Timer]\nOnCalendar=daily\n",
                encoding="utf-8",
            )
            (cfg_dir / "timed-only.service").write_text(
                "[Unit]\nDescription=Runs at 15:00\n[Timer]\nOnCalendar=*:1500\n[Service]\nExecStart=/bin/true\n",
                encoding="utf-8",
            )

            now_us = int((time.time() + 3600) * 1_000_000)
            last_us = int((time.time() - 600) * 1_000_000)

            units_out = json.dumps([
                {"unit": "flame.service", "active": "active", "sub": "running", "load": "loaded"},
                {"unit": "daily-job.service", "active": "inactive", "sub": "dead", "load": "loaded"},
                {"unit": "daily-job.timer", "active": "active", "sub": "waiting", "load": "loaded"},
            ])
            timers_out = json.dumps([
                {
                    "unit": "daily-job.timer",
                    "activates": "daily-job.service",
                    "next": now_us,
                    "left": now_us,
                    "last": last_us,
                }
            ])

            def fake_run(cmd, **kwargs):
                if "list-units" in cmd:
                    return MagicMock(returncode=0, stdout=units_out)
                if "list-timers" in cmd:
                    return MagicMock(returncode=0, stdout=timers_out)
                return MagicMock(returncode=1, stdout="")

            with patch.object(scanner, "CONFIG_DIR", cfg_dir), patch.object(
                scanner, "QUADLET_DIR", quad_dir
            ), patch("shutil.which", return_value="/usr/bin/systemctl"), patch(
                "subprocess.run", side_effect=fake_run
            ):
                services, timers = scanner.scan_systemd_units()
                self.assertEqual(services["flame.service"]["port"], 5050)
                self.assertIsNone(services["timed-only.service"]["port"])

                timer_info = services["daily-job.service"]["timer"]
                self.assertIsNotNone(timer_info)
                self.assertEqual(timer_info["active_state"], "active")
                self.assertIn("left", timer_info["left_str"])
                self.assertIn("ago", timer_info["passed_str"])
                self.assertNotIn("179", timer_info["left_str"])
                self.assertRegex(timer_info["last_str"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
                self.assertEqual(timers["daily-job.timer"]["active_state"], "active")

    def test_symlink_containment_and_unit_save(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            base = Path(tmp_dir)
            cfg_dir = base / "user"
            evil_dir = base / "user_evil"
            quad_dir = base / "quadlets"
            cfg_dir.mkdir()
            evil_dir.mkdir()
            quad_dir.mkdir()

            secret = evil_dir / "evil.service"
            secret.write_text("secret", encoding="utf-8")
            (cfg_dir / "escaped.service").symlink_to(secret)
            (cfg_dir / "real.service").write_text("[Service]\nExecStart=/bin/true\n", encoding="utf-8")

            with patch.object(scanner, "CONFIG_DIR", cfg_dir), patch.object(
                scanner, "QUADLET_DIR", quad_dir
            ), patch("shutil.which", return_value=None):
                with self.assertRaises(ValueError):
                    scanner.get_unit_content("escaped.service")
                backup = scanner.save_unit_content("real.service", "[Service]\nExecStart=/bin/echo ok\n")
                self.assertTrue(Path(backup).exists())
                self.assertIn("echo ok", Path(cfg_dir / "real.service").read_text(encoding="utf-8"))

    def test_escaped_unit_names_preserved_for_api_calls(self):
        raw_unit = "sys-devices-pci\\x2d0000.path"
        with patch(
            "scanner._run_json_cmd",
            side_effect=[
                [{"unit": raw_unit, "active": "active", "sub": "waiting"}],
                [],
            ],
        ), patch("shutil.which", return_value="/usr/bin/systemctl"):
            watchers = scanner.scan_watchers_and_sockets()
            self.assertEqual(len(watchers), 1)
            self.assertEqual(watchers[0]["name"], raw_unit)
            self.assertEqual(watchers[0]["display_name"], "sys-devices-pci-0000.path")

    def test_has_transient_states(self):
        self.assertFalse(app.has_transient_states({}))
        self.assertFalse(app.has_transient_states({"services": [{"active_state": "active", "sub_state": "running"}]}))
        self.assertFalse(app.has_transient_states({"services": [{"active_state": "inactive", "sub_state": "dead"}]}))
        self.assertTrue(app.has_transient_states({"services": [{"active_state": "activating", "sub_state": "start-post"}]}))
        self.assertTrue(app.has_transient_states({"services": [{"active_state": "activating", "sub_state": "running"}]}))
        self.assertTrue(app.has_transient_states({"services": [{"active_state": "deactivating", "sub_state": "stop-sigterm"}]}))
        self.assertTrue(app.has_transient_states({"services": [{"active_state": "active", "sub_state": "start-pre"}]}))
        self.assertTrue(app.has_transient_states({"containers": [{"state": "restarting"}]}))

    def test_services_cache_ttl_and_transient_expiration_and_refresh(self):
        data_active = {"services": [{"name": "flame.service", "active_state": "active", "sub_state": "running"}]}
        data_activating = {"services": [{"name": "flame.service", "active_state": "activating", "sub_state": "start-post"}]}

        with patch("scanner.scan_all") as mock_scan:
            mock_scan.return_value = data_active

            with app.cache_lock:
                app.cached_data = None
                app.last_services_scan = 0.0

            res1 = self.client.get("/api/services")
            self.assertEqual(res1.status_code, 200)
            self.assertEqual(mock_scan.call_count, 1)

            res2 = self.client.get("/api/services")
            self.assertEqual(res2.status_code, 200)
            self.assertEqual(mock_scan.call_count, 1)

            with app.cache_lock:
                app.last_services_scan = time.time() - 15.0

            res3 = self.client.get("/api/services")
            self.assertEqual(res3.status_code, 200)
            self.assertEqual(mock_scan.call_count, 2)

            mock_scan.return_value = data_activating
            with app.cache_lock:
                app.last_services_scan = time.time() - 15.0

            self.client.get("/api/services")
            self.assertEqual(mock_scan.call_count, 3)

            with app.cache_lock:
                app.last_services_scan = time.time() - 1.0
            self.client.get("/api/services")
            self.assertEqual(mock_scan.call_count, 3)

            with app.cache_lock:
                app.last_services_scan = time.time() - 3.0
            self.client.get("/api/services")
            self.assertEqual(mock_scan.call_count, 4)

    def test_lifespan_settling_scan_updates_caches(self):
        settled_services = {"services": [{"name": "settled.service", "active_state": "active"}]}
        settled_system = {"system_timers": [], "cron_jobs": [], "watchers": [], "failed_units": [], "stats": {}}

        with patch("scanner.scan_all", side_effect=[{"services": []}, settled_services]), patch(
            "scanner.scan_system_tasks", side_effect=[{"stats": {}}, settled_system]
        ), patch.object(app, "STARTUP_SETTLING_DELAY", 0.01):
            with TestClient(app.app):
                time.sleep(0.08)
            with app.cache_lock:
                self.assertEqual(app.cached_data, settled_services)
                self.assertEqual(app.cached_system_data, settled_system)
                app.cached_data = None
                app.cached_system_data = None
                app.last_services_scan = 0.0
                app.last_system_scan = 0.0

    def test_unit_name_and_scope_validation(self):
        self.assertEqual(scanner.validate_unit_name("docker.service"), "docker.service")
        self.assertEqual(scanner.validate_unit_name("user@1000.service"), "user@1000.service")
        self.assertEqual(scanner.validate_unit_name("fstrim.timer"), "fstrim.timer")
        self.assertEqual(scanner.validate_unit_name("-.mount"), "-.mount")
        self.assertEqual(scanner.validate_unit_name("-.slice"), "-.slice")

        invalid_names = [
            "--output=json",
            "-H127.0.0.1",
            "../../etc/shadow",
            "test;rm -rf /",
            "service with spaces",
            "test&whoami",
            "test|id",
            "",
            "   ",
            "a" * 300,
        ]
        for bad_name in invalid_names:
            with self.assertRaises(ValueError):
                scanner.validate_unit_name(bad_name)

        self.assertEqual(scanner.validate_scope("user"), "user")
        self.assertEqual(scanner.validate_scope("system"), "system")
        self.assertEqual(scanner.validate_scope(None, default="user"), "user")
        with self.assertRaises(ValueError):
            scanner.validate_scope("invalid_scope")
        with self.assertRaises(ValueError):
            scanner.validate_scope("--all")

    def test_api_validation_rejections(self):
        res1 = self.client.get("/api/service/--bad-flag/logs")
        self.assertEqual(res1.status_code, 400)

        res2 = self.client.get("/api/service/test.service/logs?scope=hacked")
        self.assertEqual(res2.status_code, 400)

        res3 = self.client.get("/api/system-unit/--version/cat")
        self.assertEqual(res3.status_code, 400)

        res4 = self.client.get("/api/system-unit/dbus.service/cat?scope=root")
        self.assertEqual(res4.status_code, 400)

        res5 = self.client.post("/api/service/--inject/action", json={"action": "restart"})
        self.assertEqual(res5.status_code, 400)

        res6 = self.client.get("/api/service/foo..bar/file")
        self.assertEqual(res6.status_code, 400)


if __name__ == "__main__":
    unittest.main()
