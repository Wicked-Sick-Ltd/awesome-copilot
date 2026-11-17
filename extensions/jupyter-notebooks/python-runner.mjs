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

SANDBOX_UNAVAILABLE_EXIT = 78

def confine_linux(workspace):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    syscall = libc.syscall
    syscall.restype = ctypes.c_long

    def check(result, what):
        if result < 0:
            error = ctypes.get_errno()
            raise OSError(error, f"{what}: {os.strerror(error)}")
        return result

    abi = check(syscall(ctypes.c_long(444), None, ctypes.c_size_t(0), ctypes.c_uint32(1)), "Landlock is unavailable")
    # Every filesystem write, create, remove, and rename right; reads stay governed by the audit hook.
    access = 0x2 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000
    if abi >= 2:
        access |= 0x2000
    if abi >= 3:
        access |= 0x4000

    class RulesetAttr(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class PathBeneathAttr(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    ruleset = RulesetAttr(access)
    ruleset_fd = check(syscall(ctypes.c_long(444), ctypes.byref(ruleset), ctypes.c_size_t(ctypes.sizeof(ruleset)), ctypes.c_uint32(0)), "landlock_create_ruleset")
    try:
        workspace_fd = os.open(workspace, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            rule = PathBeneathAttr(access, workspace_fd)
            check(syscall(ctypes.c_long(445), ctypes.c_int(ruleset_fd), ctypes.c_int(1), ctypes.byref(rule), ctypes.c_uint32(0)), "landlock_add_rule")
        finally:
            os.close(workspace_fd)
        check(libc.prctl(ctypes.c_int(38), ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)), "PR_SET_NO_NEW_PRIVS")
        check(syscall(ctypes.c_long(446), ctypes.c_int(ruleset_fd), ctypes.c_uint32(0)), "landlock_restrict_self")
    finally:
        os.close(ruleset_fd)

def confine_darwin(workspace):
    import ctypes
    libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    sandbox_init = libsystem.sandbox_init
    sandbox_init.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]
    sandbox_init.restype = ctypes.c_int
    quoted = str(workspace).replace("\\", "\\\\").replace('"', '\\"')
    # file-write* is only the file-write-* family. mkfifo, mknod, and link are separate operations.
    profile = f'(version 1)(allow default)(deny file-write* file-mknod file-link (require-not (subpath "{quoted}")))'
    error = ctypes.c_char_p()
    if sandbox_init(profile.encode("utf-8"), 0, ctypes.byref(error)) != 0:
        detail = error.value.decode("utf-8", "replace") if error.value else "unknown error"
        raise OSError(f"sandbox_init: {detail}")

# The audit hook cannot see every call that creates filesystem nodes (os.mkfifo and os.mknod raise
# no audit event, and exec'd programs run without the hook), so writes are confined by the kernel.
# The confinement is inherited across exec and cannot be lifted by the cell.
if sys.platform != "win32":
    try:
        if sys.platform.startswith("linux"):
            confine_linux(WORKSPACE)
        elif sys.platform == "darwin":
            confine_darwin(WORKSPACE)
        else:
            raise OSError(f"no filesystem sandbox is available on {sys.platform}")
    except Exception as exc:
        sys.stderr.write(
            "Notebook execution needs a filesystem sandbox that confines writes to its temporary "
            f"directory (Landlock on Linux, Seatbelt on macOS), and it could not be enabled: {exc}\n"
        )
        sys.exit(SANDBOX_UNAVAILABLE_EXIT)

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

export const sandboxUnavailableExitCode = 78;

const supportedRuntimes = ["python3", "python"];

// Notebook metadata is untrusted, so it may only pick one of the supported interpreters.
export function runtimeCommands(preferredRuntime) {
    if (!preferredRuntime) {
        return [...supportedRuntimes];
    }
    return supportedRuntimes.includes(preferredRuntime) ? [preferredRuntime] : null;
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
