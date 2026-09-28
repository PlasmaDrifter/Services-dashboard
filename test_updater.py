import unittest
from fastapi.testclient import TestClient
from app import app, APP_VERSION

class TestUpdaterEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_status_endpoint(self):
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertIn("version", data)

    def test_check_update_endpoint(self):
        response = self.client.get("/api/check-update")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertIn("update_info", data)

    def test_logs_endpoint(self):
        from unittest.mock import patch
        with patch("scanner.get_service_logs") as mock_logs:
            mock_logs.return_value = "Sep 25 12:00:00 service started"
            response = self.client.get("/api/service/test.service/logs?lines=50")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data.get("name"), "test.service")
            self.assertEqual(data.get("logs"), "Sep 25 12:00:00 service started")
            mock_logs.assert_called_once_with("test.service", lines=50, scope="user")

    def test_apply_update_endpoint(self):
        from unittest.mock import patch
        with patch("app.apply_self_update") as mock_apply, \
             patch("app.trigger_server_restart") as mock_restart:
            mock_apply.return_value = {"mode": "git", "message": "Updated via git pull", "tag": "v1.2.1"}
            response = self.client.post("/api/apply-update")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data.get("status"), "restarting")
            self.assertEqual(data.get("mode"), "git")
            mock_apply.assert_called_once()
            mock_restart.assert_called_once()

    def test_safe_archive_extraction(self):
        import io
        import os
        import tarfile
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            tar_path = os.path.join(temp_dir, "sample.tar.gz")
            with tarfile.open(tar_path, "w:gz") as tar:
                content = b"print('updated')\n"
                info = tarfile.TarInfo(name="Services-dashboard-1.2.1/test_file.py")
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))

            dest_dir = os.path.join(temp_dir, "extracted")
            os.makedirs(dest_dir, exist_ok=True)
            with tarfile.open(tar_path, "r:gz") as tar:
                if hasattr(tarfile, "data_filter"):
                    tar.extractall(path=dest_dir, filter="data")
                else:
                    tar.extractall(path=dest_dir)

            extracted_file = os.path.join(dest_dir, "Services-dashboard-1.2.1", "test_file.py")
            self.assertTrue(os.path.isfile(extracted_file))
            with open(extracted_file, "r") as f:
                self.assertIn("updated", f.read())

    def test_scan_docker_containers(self):
        from unittest.mock import patch, MagicMock
        import scanner

        mock_ndjson = (
            '{"ID":"e1f2a3b4c5d6","Names":"/my-web-app","Image":"nginx:alpine",'
            '"State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:8088->80/tcp, :::8088->80/tcp"}\n'
            '{"ID":"1234567890ab","Names":"worker-task","Image":"redis:alpine",'
            '"State":"exited","Status":"Exited (0) 10 minutes ago","Ports":""}\n'
        )

        with patch("shutil.which", return_value="/usr/bin/docker"), \
             patch("subprocess.run") as mock_run:
            mock_proc = MagicMock()
            mock_proc.returncode = 0
            mock_proc.stdout = mock_ndjson
            mock_run.return_value = mock_proc

            containers = scanner.scan_docker_containers()
            self.assertEqual(len(containers), 2)

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

    def test_scan_all_container_stats(self):
        from unittest.mock import patch
        import scanner

        fake_podman = [{"name": "p1", "state": "running", "port": 5000, "engine": "podman"}]
        fake_docker = [{"name": "d1", "state": "running", "port": 8080, "engine": "docker"}]

        with patch("scanner.scan_systemd_units", return_value=({}, {})), \
             patch("scanner.scan_podman_containers", return_value=fake_podman), \
             patch("scanner.scan_docker_containers", return_value=fake_docker):
            res = scanner.scan_all()
            stats = res["stats"]
            self.assertEqual(stats["total_containers"], 2)
            self.assertEqual(stats["podman_containers"], 1)
            self.assertEqual(stats["docker_containers"], 1)
            self.assertEqual(stats["running_containers"], 2)

    def test_version_comparison(self):
        from app import is_newer_version
        self.assertTrue(is_newer_version("v1.1.5", "v1.1.4"))
        self.assertTrue(is_newer_version("1.2.1", "1.2.0"))
        self.assertFalse(is_newer_version("v1.1.5", "v1.1.5"))
        self.assertFalse(is_newer_version("v1.1.4", "v1.1.5"))
        self.assertFalse(is_newer_version("1.0.0", "1.1.0"))

    def test_stale_cache_evaluated_against_current_version(self):
        import time
        from unittest.mock import patch
        import app

        # Simulate metadata.json containing stale cache from prior to update:
        # has_update was recorded as True for v1.1.5, but the app is now at v1.1.5
        stale_meta = {
            "last_checked": time.time() - 300,
            "latest_version": app.APP_VERSION,
            "release_url": "https://github.com/PlasmaDrifter/Services-dashboard/releases/tag/" + app.APP_VERSION,
            "has_update": True,
        }

        with patch("scanner.get_cached_update", return_value=stale_meta):
            with app.UPDATE_CACHE["lock"]:
                app.UPDATE_CACHE["last_checked"] = 0
                app.UPDATE_CACHE["latest_version"] = app.APP_VERSION
                app.UPDATE_CACHE["has_update"] = True

            result = app.check_github_update(force=False, enabled=True)
            self.assertFalse(
                result["has_update"],
                "has_update must be False when latest_version matches current_version, even if cached as True"
            )

    def test_apply_update_clears_update_cache(self):
        from unittest.mock import patch
        import app

        with patch("subprocess.run") as mock_run, \
             patch("scanner.set_cached_update") as mock_set_cache, \
             patch("os.path.isdir", return_value=True):
            mock_proc = unittest.mock.MagicMock()
            mock_proc.returncode = 0
            mock_proc.stdout = ""
            mock_proc.stderr = ""
            mock_run.return_value = mock_proc

            app.UPDATE_CACHE["has_update"] = True
            app.apply_self_update(target_tag=app.APP_VERSION)

            self.assertFalse(app.UPDATE_CACHE["has_update"])
            mock_set_cache.assert_called_once()
            saved = mock_set_cache.call_args[0][0]
            self.assertFalse(saved["has_update"])

    def test_apply_update_git_diverged_fallback(self):
        from unittest.mock import patch, MagicMock
        import app

        # Call sequence:
        # 1. git status --porcelain (clean)
        # 2. git pull --ff-only (fails with code 128 - diverged)
        # 3. git fetch --prune --tags origin (succeeds)
        # 4. git rev-parse --abbrev-ref HEAD (returns "main")
        # 5. git reset --hard origin/main (succeeds)
        p_status = MagicMock(returncode=0, stdout="", stderr="")
        p_pull = MagicMock(returncode=128, stdout="", stderr="fatal: Not possible to fast-forward, aborting.")
        p_fetch = MagicMock(returncode=0, stdout="", stderr="")
        p_branch = MagicMock(returncode=0, stdout="main\n", stderr="")
        p_reset = MagicMock(returncode=0, stdout="HEAD is now at 1234abc", stderr="")

        with patch("subprocess.run", side_effect=[p_status, p_pull, p_fetch, p_branch, p_reset]) as mock_run, \
             patch("scanner.set_cached_update") as mock_set_cache, \
             patch("os.path.isdir", return_value=True):
            app.UPDATE_CACHE["has_update"] = True
            result = app.apply_self_update(target_tag="v1.1.9")

            self.assertEqual(result["mode"], "git-reset")
            self.assertIn("Synchronized via reset to origin/main", result["message"])
            self.assertFalse(app.UPDATE_CACHE["has_update"])
            self.assertEqual(mock_run.call_count, 5)

    def test_settings_endpoints(self):
        import tempfile
        import scanner
        from pathlib import Path
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as temp_dir:
            test_meta_file = Path(temp_dir) / "metadata.json"
            with patch.object(scanner, "METADATA_FILE", test_meta_file):
                # GET initial settings
                res = self.client.get("/api/settings")
                self.assertEqual(res.status_code, 200)
                data = res.json()
                self.assertEqual(data.get("status"), "ok")
                self.assertFalse(data["settings"]["show_appindex_link"])

                # POST update show_appindex_link
                post_res = self.client.post("/api/settings", json={"show_appindex_link": True, "open_appindex_same_tab": True})
                self.assertEqual(post_res.status_code, 200)
                post_data = post_res.json()
                self.assertEqual(post_data.get("status"), "ok")
                self.assertTrue(post_data["settings"]["show_appindex_link"])
                self.assertTrue(post_data["settings"]["open_appindex_same_tab"])

                # Verify persistence
                verify_res = self.client.get("/api/settings")
                self.assertEqual(verify_res.status_code, 200)
                self.assertTrue(verify_res.json()["settings"]["show_appindex_link"])

    def test_system_tasks_endpoints(self):
        from unittest.mock import patch
        fake_tasks = {
            "system_timers": [{"name": "fstrim.timer", "scope": "system"}],
            "cron_jobs": [{"name": "daily", "scope": "system"}],
            "watchers": [{"name": "test.socket", "scope": "system"}],
            "failed_units": [],
            "stats": {"total_system_timers": 1, "is_healthy": True}
        }
        with patch("scanner.scan_system_tasks", return_value=fake_tasks), \
             patch("scanner.get_system_unit_cat", return_value="[Unit]\nDescription=Test Timer"):
            
            # GET /api/system-tasks
            res = self.client.get("/api/system-tasks")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(len(data["system_timers"]), 1)
            self.assertTrue(data["stats"]["is_healthy"])

            # POST /api/system-tasks/scan
            scan_res = self.client.post("/api/system-tasks/scan")
            self.assertEqual(scan_res.status_code, 200)
            scan_data = scan_res.json()
            self.assertEqual(scan_data["status"], "ok")
            self.assertEqual(len(scan_data["data"]["system_timers"]), 1)

            # GET /api/system-unit/{name}/cat
            cat_res = self.client.get("/api/system-unit/fstrim.timer/cat?scope=system")
            self.assertEqual(cat_res.status_code, 200)
            cat_data = cat_res.json()
            self.assertEqual(cat_data["name"], "fstrim.timer")
            self.assertIn("Description=Test Timer", cat_data["content"])

if __name__ == "__main__":
    unittest.main()

