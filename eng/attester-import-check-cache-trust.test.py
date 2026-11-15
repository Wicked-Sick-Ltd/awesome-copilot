"""Failing spec for the attester import-check cache trust bug.

The hook in hooks/attester-import-check/check-imports.py stores oracle
answers in ~/.cache/attester-import-check/cache.json and, while an entry is
fresh, returns that entry's exists flag without asking the oracle. These
tests run the real script. A local HTTP server stands in for the oracle and
answers with the JSON shape the script parses (exists / adjacent_to). The
server is not attester.dev.

They fail while a fresh cache entry can allow a package the oracle says is
missing, or block a package the oracle says is present. They pass once a
package introduced by the current edit is decided by the oracle response
rather than by that file. Reading the same cache path again during the hook
process does not satisfy the tests: the planted file stays in place for the
whole run, so a second read still sees the planted exists flag.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "hooks" / "attester-import-check" / "check-imports.py"
ORACLE_PATH = "/demo/v1/package/exists"
POSITIVE_TTL_S = 30 * 24 * 3600

PYPI_MISSING = "slopsquat_cache_trust_pypi"
NPM_MISSING = "slopsquat-cache-trust-npm"
PYPI_PRESENT = "slopsquat_cache_trust_present"


class OracleHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode())
        except ValueError:
            body = {"_raw": raw.decode(errors="replace")}
        self.server.requests.append({"path": self.path, "body": body})
        if self.path != ORACLE_PATH:
            self._send(404, {"error": "not found"})
            return
        name = body.get("name") if isinstance(body, dict) else None
        exists = name in self.server.existing
        self._send(200, {"exists": exists, "adjacent_to": []})

    def _send(self, status, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt, *args):
        return


class CacheTrustTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), OracleHandler)
        cls.server.requests = []
        cls.server.existing = set()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.server.requests.clear()
        self.server.existing.clear()
        self.home = Path(tempfile.mkdtemp(prefix="attester-home-"))
        self.work = Path(tempfile.mkdtemp(prefix="attester-work-"))

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.work, ignore_errors=True)

    def cache_path(self):
        return self.home / ".cache" / "attester-import-check" / "cache.json"

    def plant_cache(self, entries):
        path = self.cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entries))
        return path

    def run_hook(self, payload):
        env = os.environ.copy()
        env["HOME"] = str(self.home)
        env["ATTESTER_MODE"] = "block"
        env["ATTESTER_BASE_URL"] = self.base_url
        env.pop("ATTESTER_IMPORT_CHECK_NO_CACHE", None)
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            env=env,
            cwd=self.work,
            timeout=15,
            check=False,
        )

    def requests_for(self, package, ecosystem):
        return [
            item
            for item in self.server.requests
            if item["path"] == ORACLE_PATH
            and item["body"].get("name") == package
            and item["body"].get("ecosystem") == ecosystem
        ]

    def assert_blocked(self, proc, package, ecosystem, registry):
        self.assertEqual(
            proc.returncode,
            1,
            f"hook allowed the import\nstdout={proc.stdout}\nstderr={proc.stderr}\n"
            f"oracle={self.server.requests}",
        )
        self.assertTrue(
            self.requests_for(package, ecosystem),
            f"oracle was not asked about {ecosystem}:{package}; "
            f"requests={self.server.requests}",
        )
        self.assertIn(
            f"attester-import-check: '{package}' does not exist on {registry}",
            proc.stderr,
        )

    def assert_allowed_after_oracle(self, proc, package, ecosystem):
        self.assertEqual(
            proc.returncode,
            0,
            f"hook blocked a package the oracle reports as present\n"
            f"stdout={proc.stdout}\nstderr={proc.stderr}\noracle={self.server.requests}",
        )
        self.assertTrue(
            self.requests_for(package, ecosystem),
            f"oracle was not asked about {ecosystem}:{package}; "
            f"requests={self.server.requests}",
        )
        self.assertNotIn("does not exist", proc.stderr)

    def positive_entry(self, exists, age_s=0):
        return {"exists": exists, "adjacent_to": [], "ts": time.time() - age_s}

    def test_uncached_missing_pypi_import_is_blocked(self):
        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "src/app.py",
                    "content": f"import {PYPI_MISSING}\n",
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_expired_positive_cache_is_rechecked_and_blocked(self):
        self.plant_cache(
            {"pypi:" + PYPI_MISSING: self.positive_entry(True, age_s=POSITIVE_TTL_S + 60)}
        )
        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "src/app.py",
                    "content": f"import {PYPI_MISSING}\n",
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_bash_write_of_cache_then_pypi_import_must_be_blocked(self):
        entry = {"pypi:" + PYPI_MISSING: self.positive_entry(True)}
        body = json.dumps(entry, separators=(",", ":"))
        command = (
            'mkdir -p "$HOME/.cache/attester-import-check" && '
            f"printf '%s' '{body}' > \"$HOME/.cache/attester-import-check/cache.json\""
        )
        allowed = self.run_hook({"toolName": "bash", "toolInput": {"command": command}})
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(self.server.requests, [])
        completed = subprocess.run(
            ["bash", "-c", command],
            env={**os.environ, "HOME": str(self.home)},
            cwd=self.work,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(self.cache_path().read_text())["pypi:" + PYPI_MISSING]["exists"], True)

        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "src/app.py",
                    "content": f"import {PYPI_MISSING}\n",
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_json_cache_edit_containing_import_text_then_import_must_be_blocked(self):
        entry = {
            "pypi:" + PYPI_MISSING: self.positive_entry(True),
            "note": "preapproved import record",
        }
        content = json.dumps(entry)
        self.assertIn("import", content)
        self.assertGreater(len(content), 15)
        allowed = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": str(self.cache_path()),
                    "content": content,
                },
            }
        )
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(self.server.requests, [])
        self.cache_path().parent.mkdir(parents=True, exist_ok=True)
        self.cache_path().write_text(content)

        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "src/app.py",
                    "content": f"import {PYPI_MISSING}\n",
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_fresh_positive_cache_must_not_allow_npm_import(self):
        self.plant_cache({"npm:" + NPM_MISSING: self.positive_entry(True)})
        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "src/app.js",
                    "content": f"import '{NPM_MISSING}';\n",
                },
            }
        )
        self.assert_blocked(proc, NPM_MISSING, "npm", "npm")

    def test_fresh_positive_cache_must_not_allow_extensionless_python_import(self):
        self.plant_cache({"pypi:" + PYPI_MISSING: self.positive_entry(True)})
        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "bin/task",
                    "content": f"import {PYPI_MISSING}\n",
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_fresh_positive_cache_must_not_allow_tool_input_file_path(self):
        self.plant_cache({"pypi:" + PYPI_MISSING: self.positive_entry(True)})
        proc = self.run_hook(
            {
                "tool_name": "Write",
                "tool_input": {
                    "file_path": "src/app.py",
                    "content": f"import {PYPI_MISSING}\n",
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_fresh_positive_cache_must_not_allow_nested_edit(self):
        self.plant_cache({"pypi:" + PYPI_MISSING: self.positive_entry(True)})
        proc = self.run_hook(
            {
                "toolName": "edit",
                "toolInput": {
                    "edits": [
                        {
                            "path": "pkg/app.py",
                            "new_str": f"import {PYPI_MISSING}\n",
                        }
                    ]
                },
            }
        )
        self.assert_blocked(proc, PYPI_MISSING, "pypi", "PyPI")

    def test_fresh_negative_cache_must_not_block_package_oracle_says_exists(self):
        self.server.existing.add(PYPI_PRESENT)
        self.plant_cache({"pypi:" + PYPI_PRESENT: self.positive_entry(False)})
        proc = self.run_hook(
            {
                "toolName": "create",
                "toolInput": {
                    "path": "src/app.py",
                    "content": f"import {PYPI_PRESENT}\n",
                },
            }
        )
        self.assert_allowed_after_oracle(proc, PYPI_PRESENT, "pypi")


if __name__ == "__main__":
    unittest.main()
