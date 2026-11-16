"""Security regression tests for the attester-import-check hook allowlist."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HOOK = pathlib.Path(__file__).parents[1] / "hooks" / "attester-import-check" / "check-imports.py"
FAKE_PACKAGE = "requestsx_fantasy_helper"


class _NotFoundOracle(BaseHTTPRequestHandler):
    queried: list[str] = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).queried.append(body["name"])
        payload = json.dumps({"exists": False, "adjacent_to": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


class AllowlistTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _NotFoundOracle)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        _NotFoundOracle.queried.clear()
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name)
        self.workspace = root / "workspace"
        self.home = root / "home"
        self.workspace.mkdir()
        self.home.mkdir()
        self.user_allowlist = self.home / ".config" / "attester-import-check" / "allowlist"

    def tearDown(self):
        self._tmp.cleanup()

    def run_hook(self, tool_input):
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.home),
            "ATTESTER_BASE_URL": f"http://127.0.0.1:{self.server.server_port}",
            "ATTESTER_IMPORT_CHECK_NO_CACHE": "1",
            "ATTESTER_MODE": "block",
        }
        return subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps({"toolName": "write_file", "toolInput": tool_input}),
            capture_output=True,
            text=True,
            cwd=self.workspace,
            env=env,
            timeout=30,
        )

    def import_edit(self):
        return {"path": "main.py", "content": f"import {FAKE_PACKAGE}\n"}

    def test_unknown_package_is_blocked(self):
        result = self.run_hook(self.import_edit())
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(FAKE_PACKAGE, _NotFoundOracle.queried)

    def test_workspace_allowlist_does_not_skip_oracle(self):
        (self.workspace / ".attester-allowlist").write_text(f"{FAKE_PACKAGE}\n")
        result = self.run_hook(self.import_edit())
        self.assertIn(FAKE_PACKAGE, _NotFoundOracle.queried)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_user_allowlist_outside_workspace_is_honored(self):
        self.user_allowlist.parent.mkdir(parents=True)
        self.user_allowlist.write_text(f"# local mirror\n{FAKE_PACKAGE}\n")
        result = self.run_hook(self.import_edit())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(FAKE_PACKAGE, _NotFoundOracle.queried)

    def test_edit_writing_user_allowlist_is_blocked(self):
        self.user_allowlist.parent.mkdir(parents=True)
        for path in (str(self.user_allowlist), "~/.config/attester-import-check/allowlist"):
            with self.subTest(path=path):
                result = self.run_hook({"path": path, "content": f"{FAKE_PACKAGE}\n"})
                self.assertEqual(result.returncode, 1, result.stderr)

    def test_edit_writing_answer_cache_is_blocked(self):
        cache = self.home / ".cache" / "attester-import-check" / "cache.json"
        forged = json.dumps({f"pypi:{FAKE_PACKAGE}": {"exists": True, "ts": 9e12}})
        result = self.run_hook({"path": str(cache), "content": forged})
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_shell_command_writing_user_allowlist_is_blocked(self):
        for command in (
            f"echo {FAKE_PACKAGE} >> ~/.config/attester-import-check/allowlist",
            f"cd ~/.config && echo {FAKE_PACKAGE} >> attester-import-check/allowlist",
        ):
            with self.subTest(command=command):
                result = self.run_hook({"command": command})
                self.assertEqual(result.returncode, 1, result.stderr)

    def test_other_casing_of_user_allowlist_is_blocked(self):
        result = self.run_hook(
            {"path": "~/.Config/Attester-Import-Check/allowlist", "content": f"{FAKE_PACKAGE}\n"}
        )
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_symlink_into_state_dir_is_blocked(self):
        self.user_allowlist.parent.mkdir(parents=True)
        (self.workspace / "notes").symlink_to(self.user_allowlist.parent)
        result = self.run_hook({"path": "notes/allowlist", "content": f"{FAKE_PACKAGE}\n"})
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_unrelated_edit_is_allowed(self):
        result = self.run_hook({"path": "README.md", "content": "Documentation update."})
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
