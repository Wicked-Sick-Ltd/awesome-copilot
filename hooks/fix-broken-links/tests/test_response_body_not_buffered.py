#!/usr/bin/env python3
"""Spec for the fix-broken-links PowerShell hook response-body bound.

The postToolUse hook in link-fix.ps1 checks every http(s) URL in an edited
web file. These tests drive that script as a hook and fail while it still
retains an oversized response body in memory, or reads more than
MAX_BODY_BYTES of that body. They pass once each status check returns the
real status code without doing either.

Call sites covered:
  * Get-HttpStatus on a direct 200 (Content-Length and chunked)
  * Get-HttpStatus after an automatic redirect to a 200
  * Get-HttpStatus when the status is not success (error-body path)
  * Get-HttpStatus from Find-Variation, used for replacement suggestions

Run:
  PWSH=/usr/bin/pwsh python3 hooks/fix-broken-links/tests/test_response_body_not_buffered.py

Requires pwsh (PowerShell 7+) and Linux /proc. The hook script itself is not
modified.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
HOOK_SCRIPT = REPO_ROOT / "hooks" / "fix-broken-links" / "link-fix.ps1"

# Large enough that a full copy cannot hide inside allocator noise, small
# enough to stay well clear of killing this machine.
BODY_BYTES = 24 * 1024 * 1024
# A status check may read a short prefix. The whole body must not be consumed.
MAX_BODY_BYTES = 256 * 1024
# VmHWM growth, after response headers and before the body, must stay under this.
MAX_RSS_GROWTH_KB = 8 * 1024
HEADER_PAUSE_SEC = 0.35
CASE_TIMEOUT_SEC = 30


@dataclass
class Outcome:
    exit_code: int
    stdout: str
    stderr: str
    requests: list[str] = field(default_factory=list)
    body_bytes: int = 0
    baseline_kb: int | None = None
    peak_kb: int | None = None


def pwsh_path() -> str:
    configured = os.environ.get("PWSH")
    if configured:
        return configured
    found = shutil.which("pwsh")
    if not found:
        raise SystemExit("pwsh (PowerShell 7+) is required; set PWSH or put pwsh on PATH")
    return found


def read_status_kb(pid: int, key: str) -> int | None:
    try:
        text = Path(f"/proc/{pid}/status").read_text()
    except OSError:
        return None
    prefix = key + ":"
    for line in text.splitlines():
        if line.startswith(prefix):
            return int(line.split()[1])
    return None


def find_hook_pid() -> int | None:
    proc = Path("/proc")
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if b"link-fix.ps1" in command:
            return int(entry.name)
    return None


class LocalSite:
    """HTTP server whose oversized responses are measured, not trusted."""

    def __init__(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(16)
        self._sock.settimeout(0.2)
        self.port = self._sock.getsockname()[1]
        self.requests: list[str] = []
        self._stop = threading.Event()
        self._measured: dict[str, dict[str, int | None]] = {}
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._sock.close()
        self._thread.join(timeout=2)

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def measured(self, path: str) -> dict[str, int | None]:
        return self._measured.get(path, {"body_bytes": 0, "baseline_kb": None, "peak_kb": None})

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _addr = self._sock.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        try:
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            try:
                conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 8192)
            except OSError:
                # Some platforms reject this buffer size. A smaller default
                # still lets the test measure the hook's body read.
                pass
            conn.settimeout(CASE_TIMEOUT_SEC)
            prefix = conn.recv(4, socket.MSG_PEEK)
            if not prefix.startswith(b"GET ") and not prefix.startswith(b"HEAD"):
                return
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                data += chunk
                if len(data) > 65536:
                    return
            request_line = data.split(b"\r\n", 1)[0].decode("iso-8859-1", "replace")
            parts = request_line.split(" ")
            if len(parts) < 2:
                return
            path = parts[1]
            self.requests.append(path)
            self._respond(conn, path)
        except OSError:
            return
        finally:
            try:
                conn.close()
            except OSError:
                # The client may already have closed the socket.
                pass

    def _respond(self, conn: socket.socket, path: str) -> None:
        if path == "/redir":
            self._send_simple(
                conn,
                "302 Found",
                b"",
                extra=f"Location: {self.url('/dest')}\r\n",
            )
            return
        if path == "/missing":
            self._send_simple(conn, "404 Not Found", b"missing")
            return
        if path == "/missing/":
            self._send_oversized(conn, path, "200 OK", "application/octet-stream", chunked=False)
            return
        if path == "/chunked":
            self._send_oversized(conn, path, "200 OK", "application/octet-stream", chunked=True)
            return
        if path == "/error-body":
            self._send_oversized(conn, path, "404 Not Found", "text/plain", chunked=False)
            return
        # /big, /dest, and any other measured success body.
        self._send_oversized(conn, path, "200 OK", "application/octet-stream", chunked=False)

    def _send_simple(self, conn: socket.socket, status: str, body: bytes, extra: str = "") -> None:
        header = (
            f"HTTP/1.1 {status}\r\n"
            "Content-Type: text/plain\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n"
            f"{extra}\r\n"
        ).encode("ascii")
        conn.sendall(header + body)

    def _send_oversized(
        self,
        conn: socket.socket,
        path: str,
        status: str,
        content_type: str,
        chunked: bool,
    ) -> None:
        if chunked:
            header = (
                f"HTTP/1.1 {status}\r\n"
                f"Content-Type: {content_type}\r\n"
                "Transfer-Encoding: chunked\r\n"
                "Connection: close\r\n"
                "\r\n"
            )
        else:
            header = (
                f"HTTP/1.1 {status}\r\n"
                f"Content-Type: {content_type}\r\n"
                f"Content-Length: {BODY_BYTES}\r\n"
                "Connection: close\r\n"
                "\r\n"
            )
        conn.sendall(header.encode("ascii"))

        # Headers are out. The hook is blocked in the body read, so the RSS
        # here is the pre-body baseline for this process.
        time.sleep(HEADER_PAUSE_SEC)
        pid = find_hook_pid()
        baseline = read_status_kb(pid, "VmHWM") if pid is not None else None
        peak = baseline
        sent = 0
        chunk = b"Z" * 65536
        try:
            while sent < BODY_BYTES:
                take = min(len(chunk), BODY_BYTES - sent)
                if chunked:
                    frame = f"{take:x}\r\n".encode("ascii") + chunk[:take] + b"\r\n"
                    conn.sendall(frame)
                else:
                    conn.sendall(chunk[:take])
                sent += take
                if pid is not None:
                    current = read_status_kb(pid, "VmHWM")
                    if current is not None:
                        peak = current if peak is None else max(peak, current)
            if chunked:
                conn.sendall(b"0\r\n\r\n")
        except OSError:
            # The hook is allowed to close the socket once it has the status
            # line. Bytes already sent are still recorded below.
            pass
        if pid is not None:
            current = read_status_kb(pid, "VmHWM")
            if current is not None:
                peak = current if peak is None else max(peak, current)
        self._measured[path] = {
            "body_bytes": sent,
            "baseline_kb": baseline,
            "peak_kb": peak,
        }


def run_hook(site: LocalSite, url: str, *, files_array: bool) -> Outcome:
    with tempfile.TemporaryDirectory(prefix="linkfix-body-") as directory:
        note = Path(directory) / "notes.md"
        # Trailing space keeps the URL regex from swallowing the newline.
        note.write_text(f"See {url} for details.\n", encoding="utf-8")
        if files_array:
            tool_input: dict[str, object] = {"files": [str(note)]}
        else:
            tool_input = {"path": str(note)}
        payload = json.dumps({"toolName": "edit", "tool_input": tool_input})
        proc = subprocess.run(
            [pwsh_path(), "-NoProfile", "-File", str(HOOK_SCRIPT)],
            input=payload,
            text=True,
            capture_output=True,
            timeout=CASE_TIMEOUT_SEC,
            check=False,
        )
    return Outcome(
        exit_code=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        requests=list(site.requests),
    )


def attach_measurement(outcome: Outcome, site: LocalSite, path: str) -> Outcome:
    measured = site.measured(path)
    outcome.body_bytes = int(measured["body_bytes"] or 0)
    outcome.baseline_kb = measured["baseline_kb"]  # type: ignore[assignment]
    outcome.peak_kb = measured["peak_kb"]  # type: ignore[assignment]
    outcome.requests = list(site.requests)
    return outcome


def check(
    name: str,
    outcome: Outcome,
    *,
    large_path: str,
    stdout_contains: tuple[str, ...],
    stdout_excludes: tuple[str, ...] = (),
) -> None:
    problems: list[str] = []
    if outcome.exit_code != 0:
        problems.append(f"exit {outcome.exit_code}, expected 0")
    if large_path not in outcome.requests:
        problems.append(f"hook never requested {large_path}; saw {outcome.requests}")
    if outcome.body_bytes > MAX_BODY_BYTES:
        problems.append(
            f"server sent {outcome.body_bytes} body bytes; cap is {MAX_BODY_BYTES}"
        )
    if outcome.baseline_kb is None or outcome.peak_kb is None:
        problems.append(
            f"no VmHWM baseline (baseline={outcome.baseline_kb}, peak={outcome.peak_kb})"
        )
    else:
        growth = outcome.peak_kb - outcome.baseline_kb
        if growth > MAX_RSS_GROWTH_KB:
            problems.append(
                f"VmHWM grew {growth} KiB after headers "
                f"({outcome.baseline_kb} -> {outcome.peak_kb}); "
                f"cap is {MAX_RSS_GROWTH_KB} KiB"
            )
    for snippet in stdout_contains:
        if snippet not in outcome.stdout:
            problems.append(f"stdout missing {snippet!r}")
    for snippet in stdout_excludes:
        if snippet in outcome.stdout:
            problems.append(f"stdout unexpectedly contained {snippet!r}")
    if problems:
        detail = "\n".join(problems)
        raise AssertionError(f"{name} failed:\n{detail}\n--- stdout ---\n{outcome.stdout}\n--- stderr ---\n{outcome.stderr}")


def case_direct_content_length() -> None:
    site = LocalSite()
    try:
        outcome = run_hook(site, site.url("/big"), files_array=True)
        attach_measurement(outcome, site, "/big")
        check(
            "direct 200 Content-Length",
            outcome,
            large_path="/big",
            stdout_contains=("Checking", "No broken links"),
            stdout_excludes=("BROKEN",),
        )
    finally:
        site.close()


def case_direct_chunked() -> None:
    site = LocalSite()
    try:
        outcome = run_hook(site, site.url("/chunked"), files_array=False)
        attach_measurement(outcome, site, "/chunked")
        check(
            "direct 200 chunked",
            outcome,
            large_path="/chunked",
            stdout_contains=("Checking", "No broken links"),
            stdout_excludes=("BROKEN",),
        )
    finally:
        site.close()


def case_redirect_to_large_body() -> None:
    site = LocalSite()
    try:
        outcome = run_hook(site, site.url("/redir"), files_array=False)
        attach_measurement(outcome, site, "/dest")
        check(
            "redirect to 200",
            outcome,
            large_path="/dest",
            stdout_contains=("Checking", "No broken links"),
            stdout_excludes=("BROKEN",),
        )
    finally:
        site.close()


def case_error_status_large_body() -> None:
    site = LocalSite()
    try:
        outcome = run_hook(site, site.url("/error-body"), files_array=False)
        attach_measurement(outcome, site, "/error-body")
        check(
            "non-success large body",
            outcome,
            large_path="/error-body",
            stdout_contains=("Checking", "BROKEN (404)"),
        )
    finally:
        site.close()


def case_variation_large_body() -> None:
    site = LocalSite()
    try:
        outcome = run_hook(site, site.url("/missing"), files_array=False)
        attach_measurement(outcome, site, "/missing/")
        check(
            "Find-Variation 200",
            outcome,
            large_path="/missing/",
            stdout_contains=("BROKEN (404)", site.url("/missing/")),
        )
    finally:
        site.close()


CASES = (
    case_direct_content_length,
    case_direct_chunked,
    case_redirect_to_large_body,
    case_error_status_large_body,
    case_variation_large_body,
)


def main() -> int:
    if not HOOK_SCRIPT.is_file():
        raise SystemExit(f"hook script not found: {HOOK_SCRIPT}")
    if not Path("/proc/self/status").is_file():
        raise SystemExit("these tests read /proc/<pid>/status and must run on Linux")
    failures = 0
    for case in CASES:
        try:
            case()
        except AssertionError as error:
            failures += 1
            print(f"FAIL {case.__name__}\n{error}\n")
        except subprocess.TimeoutExpired as error:
            failures += 1
            print(f"FAIL {case.__name__}\ntimed out after {error.timeout}s\n")
        else:
            print(f"PASS {case.__name__}")
    print(f"{len(CASES) - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
