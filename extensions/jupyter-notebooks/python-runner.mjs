// Python process that executes notebook cells inside the isolated execution directory.

import { spawn } from "node:child_process";

export const pythonRunner = String.raw`
import ast
import base64
import contextlib
import io
import json
import os
import pathlib
import sys
import traceback
try:
    import resource
except ImportError:
    resource = None

payload = json.load(sys.stdin)
namespace = {}
results = []
MAX_CAPTURE = 250_000
WORKSPACE = pathlib.Path.cwd().resolve()
if resource is not None:
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (25, 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (10 * 1024 * 1024, 10 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except (AttributeError, OSError, ValueError):
        pass
READ_ROOTS = [WORKSPACE]
for entry in [sys.base_prefix, sys.prefix, *sys.path]:
    if entry:
        try:
            READ_ROOTS.append(pathlib.Path(entry).resolve())
        except (OSError, TypeError):
            pass

class LimitedBuffer(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit
        self.written = 0
        self.truncated = False

    def write(self, value):
        value = str(value)
        remaining = self.limit - self.written
        if remaining <= 0:
            self.truncated = True
            return len(value)
        chunk = value[:remaining]
        self.written += len(chunk)
        if len(chunk) < len(value):
            self.truncated = True
        super().write(chunk)
        return len(value)

    def value(self):
        suffix = "\n[output truncated]" if self.truncated else ""
        return self.getvalue() + suffix

def resolve_path(value):
    if isinstance(value, int):
        return None
    try:
        return pathlib.Path(value).resolve()
    except (OSError, TypeError, ValueError):
        raise PermissionError("Unable to resolve filesystem path")

def under(path_value, roots):
    if path_value is None:
        return True
    return any(path_value == root or root in path_value.parents for root in roots)

def audit(event, args):
    if event.startswith(("socket.", "subprocess.", "ctypes.", "pty.")) or event in {
        "os.system", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty"
    }:
        raise PermissionError(f"{event} is disabled in notebook execution")
    if event == "open":
        target = resolve_path(args[0])
        mode = str(args[1]) if len(args) > 1 else "r"
        write_mode = any(flag in mode for flag in ("w", "a", "x", "+"))
        roots = [WORKSPACE] if write_mode else READ_ROOTS
        if not under(target, roots):
            raise PermissionError("Filesystem access outside the isolated workspace is disabled")
    if event in {"os.listdir", "os.scandir", "os.chdir"} and args:
        if not under(resolve_path(args[0]), READ_ROOTS):
            raise PermissionError("Directory access outside the isolated workspace is disabled")
    if event in {
        "os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.truncate",
        "os.link", "os.symlink"
    } and args:
        if not under(resolve_path(args[0]), [WORKSPACE]):
            raise PermissionError("Filesystem changes outside the isolated workspace are disabled")
    if event in {"os.rename", "os.replace"}:
        if any(not under(resolve_path(value), [WORKSPACE]) for value in args[:2]):
            raise PermissionError("Filesystem changes outside the isolated workspace are disabled")

sys.addaudithook(audit)

def rich_repr(value):
    data = {}
    if value is None:
        return data
    try:
        html_method = getattr(value, "_repr_html_", None)
        if callable(html_method):
            html = html_method()
            if html:
                data["text/html"] = str(html)[:MAX_CAPTURE]
    except Exception:
        pass
    try:
        png_method = getattr(value, "_repr_png_", None)
        if callable(png_method):
            png = png_method()
            if png:
                if isinstance(png, tuple):
                    png = png[0]
                data["image/png"] = base64.b64encode(png).decode("ascii")
    except Exception:
        pass
    rendered = repr(value)
    data["text/plain"] = rendered[:MAX_CAPTURE]
    if len(rendered) > MAX_CAPTURE:
        data["text/plain"] += "\n[result truncated]"
    return data

def capture_figures():
    displays = []
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return displays
    for number in pyplot.get_fignums():
        buffer = io.BytesIO()
        pyplot.figure(number).savefig(buffer, format="png", bbox_inches="tight")
        displays.append({"image/png": base64.b64encode(buffer.getvalue()).decode("ascii")})
        buffer.close()
    pyplot.close("all")
    return displays

def run_cell(cell, index):
    stdout = LimitedBuffer(MAX_CAPTURE)
    stderr = LimitedBuffer(MAX_CAPTURE)
    result_data = {}
    displays = []
    error = None
    code = cell.get("code") or ""
    try:
        tree = ast.parse(code, filename=f"<cell {index + 1}>", mode="exec")
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last_expr = ast.Expression(tree.body[-1].value)
                tree.body = tree.body[:-1]
                ast.fix_missing_locations(tree)
                ast.fix_missing_locations(last_expr)
                if tree.body:
                    exec(compile(tree, f"<cell {index + 1}>", "exec"), namespace, namespace)
                value = eval(compile(last_expr, f"<cell {index + 1}>", "eval"), namespace, namespace)
                result_data = rich_repr(value)
            else:
                exec(compile(tree, f"<cell {index + 1}>", "exec"), namespace, namespace)
            displays = capture_figures()
    except Exception as exc:
        error = {
            "ename": exc.__class__.__name__,
            "evalue": str(exc),
            "traceback": traceback.format_exc().splitlines(),
        }
    return {
        "id": cell.get("id"),
        "stdout": stdout.value(),
        "stderr": stderr.value(),
        "resultData": result_data,
        "displays": displays,
        "error": error,
    }

for index, cell in enumerate(payload.get("cells", [])):
    results.append(run_cell(cell, index))
    if results[-1]["error"] is not None and payload.get("stopOnError", True):
        break

print(json.dumps({"results": results}))
`;

export function runtimeCommands(preferredRuntime) {
    return preferredRuntime ? [preferredRuntime] : ["python3", "python"];
}

export function spawnPythonRunner(command, executionDir, detached) {
    return spawn(command, ["-I", "-c", pythonRunner], {
        cwd: executionDir,
        detached,
        env: {
            HOME: executionDir,
            LANG: "C.UTF-8",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            PYTHONIOENCODING: "utf-8",
            PYTHONUNBUFFERED: "1",
            TMPDIR: executionDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
}
