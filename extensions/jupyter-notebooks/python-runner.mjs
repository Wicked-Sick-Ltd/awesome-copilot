// Python source for the notebook cell runner. Kept free of SDK imports so tests can execute it directly.

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
WORKSPACE_ALIASES = []
for entry in [str(WORKSPACE), os.getcwd(), os.environ.get("TMPDIR"), os.environ.get("HOME")]:
    try:
        alias = pathlib.PurePath(entry)
        if (
            alias.is_absolute()
            and ".." not in alias.parts
            and alias not in WORKSPACE_ALIASES
            and pathlib.Path(entry).resolve() == WORKSPACE
        ):
            WORKSPACE_ALIASES.append(alias)
    except (OSError, TypeError, ValueError):
        pass
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

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

# Metadata, link, rename and chdir targets are checked lexically rather than by
# resolving them, because a cell can swap symlinks between this hook and the
# syscall. A path without ".." under a workspace alias stays inside the
# workspace only while every symlink in it also points inside without "..",
# which the os.symlink, os.link and os.rename checks below preserve.
def text_path(value):
    if type(value) is bytes:
        value = os.fsdecode(value)
    if type(value) is not str:
        raise PermissionError("Filesystem changes through file descriptors are disabled")
    return pathlib.PurePath(value)

def lexically_in_workspace(candidate, allow_root=True):
    if any(alias in candidate.parents for alias in WORKSPACE_ALIASES):
        return True
    return allow_root and candidate in WORKSPACE_ALIASES

def require_workspace_change(value, allow_root=True):
    candidate = text_path(value)
    if ".." in candidate.parts:
        raise PermissionError("Filesystem changes through '..' are disabled in the isolated workspace")
    if not candidate.is_absolute():
        if candidate.anchor:
            raise PermissionError("Filesystem changes outside the isolated workspace are disabled")
        try:
            candidate = pathlib.PurePath(os.getcwd()) / candidate
        except OSError:
            raise PermissionError("Unable to resolve the current directory")
    if not lexically_in_workspace(candidate, allow_root):
        raise PermissionError("Filesystem changes outside the isolated workspace are disabled")

def require_workspace_link_target(value):
    target = text_path(value)
    if ".." in target.parts or (target.anchor and not lexically_in_workspace(target)):
        raise PermissionError("Symlinks must point inside the isolated workspace without '..'; others are disabled")

def require_default_dir_fd(value):
    if value is not None and value != -1:
        raise PermissionError("Directory-relative filesystem changes are disabled")

def audit(event, args):
    if event.startswith(("socket.", "subprocess.", "ctypes.", "pty.")) or event in {
        "os.system", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty"
    }:
        raise PermissionError(f"{event} is disabled in notebook execution")
    if event == "open":
        target = resolve_path(args[0])
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 and type(args[2]) is int and args[2] >= 0 else 0
        write_mode = (
            isinstance(mode, str) and any(flag in mode for flag in ("w", "a", "x", "+"))
        ) or bool(flags & WRITE_FLAGS)
        roots = [WORKSPACE] if write_mode else READ_ROOTS
        if not under(target, roots):
            raise PermissionError("Filesystem access outside the isolated workspace is disabled")
    if event in {"os.listdir", "os.scandir"} and args:
        if not under(resolve_path(args[0]), READ_ROOTS):
            raise PermissionError("Directory access outside the isolated workspace is disabled")
    if event == "os.chdir" and args:
        require_workspace_change(args[0])
    if event in {
        "os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.truncate"
    } and args:
        if not under(resolve_path(args[0]), [WORKSPACE]):
            raise PermissionError("Filesystem changes outside the isolated workspace are disabled")
    if event in {"os.utime", "os.chflags", "os.setxattr", "os.removexattr"} and args:
        require_workspace_change(args[0])
        if event == "os.utime" and len(args) > 3:
            require_default_dir_fd(args[3])
    if event == "os.symlink" and len(args) >= 2:
        require_workspace_link_target(args[0])
        require_workspace_change(args[1], allow_root=False)
        require_default_dir_fd(args[2] if len(args) > 2 else None)
    if event in {"os.link", "os.rename", "os.replace"} and len(args) >= 2:
        for value in args[:2]:
            require_workspace_change(value, allow_root=False)
        for value in args[2:4]:
            require_default_dir_fd(value)
    if event == "_winapi.CreateJunction":
        raise PermissionError("Junctions are disabled in notebook execution")

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

export function pythonRunnerEnv(executionDir) {
    return {
        HOME: executionDir,
        LANG: "C.UTF-8",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        TMPDIR: executionDir,
    };
}
