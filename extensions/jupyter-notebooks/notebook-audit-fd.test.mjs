import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const canvasSource = fileURLToPath(new URL("./notebook-canvas.mjs", import.meta.url));
const markerText = "MARKER-CONTENTS-KEEP\n";
const markerMode = 0o644;

// The product runner is the String.raw template spawned as `python -I -c`.
// Keep this extraction aligned with runPythonCommand so a hook fix in that
// template is what makes the cases below pass.
function loadPythonRunner() {
    const source = readFileSync(canvasSource, "utf8");
    const header = "const pythonRunner = String.raw`";
    const start = source.indexOf(header);
    assert.notEqual(start, -1, "pythonRunner template was not found");
    const bodyStart = start + header.length;
    const end = source.indexOf("`;", bodyStart);
    assert.notEqual(end, -1, "pythonRunner template did not end");
    const runner = source.slice(bodyStart, end);
    assert.match(runner, /sys\.addaudithook\(audit\)/);
    return runner;
}

const pythonRunner = loadPythonRunner();

let interpreterRoot;
let pythonBin;
let markerPath;

function markerExpression() {
    return `os.path.join(sys.prefix, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages", "install_marker.py")`;
}

function cell(body) {
    return `import os, sys\npath = ${markerExpression()}\n${body}`;
}

before(() => {
    interpreterRoot = mkdtempSync(join(tmpdir(), "notebook-audit-prefix-"));
    execFileSync("python3", ["-m", "venv", "--without-pip", interpreterRoot], { stdio: "ignore" });
    pythonBin = join(interpreterRoot, "bin", "python");
    markerPath = execFileSync(pythonBin, ["-I", "-c", `import os, sys\nprint(${markerExpression()})`], {
        encoding: "utf8",
    }).trim();
    mkdirSync(dirname(markerPath), { recursive: true });
    const prefix = execFileSync(pythonBin, ["-I", "-c", "import sys; print(sys.prefix)"], {
        encoding: "utf8",
    }).trim();
    assert.equal(prefix, interpreterRoot);
    assert.equal(markerPath.startsWith(`${interpreterRoot}/`), true);
});

after(() => {
    if (interpreterRoot) {
        rmSync(interpreterRoot, { recursive: true, force: true });
    }
});

function snapshotMarker() {
    const info = statSync(markerPath);
    return {
        content: readFileSync(markerPath, "utf8"),
        mode: info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
    };
}

function resetMarker() {
    writeFileSync(markerPath, markerText);
    chmodSync(markerPath, markerMode);
}

function runCell(code) {
    const executionDir = mkdtempSync(join(tmpdir(), "copilot-notebook-"));
    return new Promise((resolve, reject) => {
        const child = spawn(pythonBin, ["-I", "-c", pythonRunner], {
            cwd: executionDir,
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
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => {
            rmSync(executionDir, { recursive: true, force: true });
            reject(error);
        });
        child.on("close", (code) => {
            rmSync(executionDir, { recursive: true, force: true });
            if (code !== 0) {
                reject(new Error(`Python runner exited ${code}: ${stderr || stdout}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            } catch (error) {
                reject(new Error(`Runner JSON parse failed: ${error.message}; stdout=${stdout}; stderr=${stderr}`));
                return;
            }
            resolve(parsed.results[0]);
        });
        child.stdin.end(JSON.stringify({
            cells: [{ id: "cell-probe", code }],
            stopOnError: true,
        }));
    });
}

async function expectPrefixMutationRejected(code) {
    resetMarker();
    const before = snapshotMarker();
    const result = await runCell(code);
    const after = snapshotMarker();
    assert.equal(after.content, before.content);
    assert.equal(after.mode, before.mode);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(
        result.error?.ename,
        "PermissionError",
        `${result.error?.ename}: ${result.error?.evalue}`,
    );
    return result;
}

test("pathname truncate and chmod of a prefix file stay inside the workspace", async () => {
    await expectPrefixMutationRejected(cell("os.truncate(path, 0)\n"));
    await expectPrefixMutationRejected(cell("os.chmod(path, 0o706)\n"));
    await expectPrefixMutationRejected(cell("open(path, 'w').close()\n"));
});

test("a prefix file can still be opened for reading", async () => {
    resetMarker();
    const result = await runCell(cell(`
with open(path, "r") as handle:
    print(handle.read(), end="")
`));
    assert.equal(result.error, null);
    assert.equal(result.stdout, markerText);
    assert.equal(snapshotMarker().mode, markerMode);
});

test("a workspace file can still be truncated by pathname", async () => {
    const result = await runCell(`
from pathlib import Path
target = Path("inside.txt")
target.write_text("abc")
import os
os.truncate(target, 0)
print(target.read_bytes())
`);
    assert.equal(result.error, null);
    assert.match(result.stdout, /b''/);
});

test("os.fchmod on a read descriptor does not change a prefix file", async () => {
    await expectPrefixMutationRejected(cell(`
with open(path, "r") as handle:
    os.fchmod(handle.fileno(), 0o706)
`));
});

test("os.chmod on a read descriptor does not change a prefix file", async () => {
    await expectPrefixMutationRejected(cell(`
with open(path, "r") as handle:
    os.chmod(handle.fileno(), 0o706)
`));
});

test("os.fchown on a read descriptor is rejected for a prefix file", async () => {
    await expectPrefixMutationRejected(cell(`
with open(path, "r") as handle:
    os.fchown(handle.fileno(), os.getuid(), os.getgid())
`));
});

test("os.chown on a read descriptor is rejected for a prefix file", async () => {
    await expectPrefixMutationRejected(cell(`
with open(path, "r") as handle:
    os.chown(handle.fileno(), os.getuid(), os.getgid())
`));
});

test("os.ftruncate on a read descriptor is rejected before it reaches the kernel", async () => {
    await expectPrefixMutationRejected(cell(`
with open(path, "r") as handle:
    os.ftruncate(handle.fileno(), 0)
`));
});

test("os.truncate on a read descriptor is rejected before it reaches the kernel", async () => {
    await expectPrefixMutationRejected(cell(`
with open(path, "r") as handle:
    os.truncate(handle.fileno(), 0)
`));
});

test("os.ftruncate on a writable descriptor does not empty a prefix file", async () => {
    // A plain read descriptor is not writable, so the kernel would reject
    // ftruncate with EINVAL. Opening read-write still has to be stopped.
    await expectPrefixMutationRejected(cell(`
fd = os.open(path, os.O_RDWR)
try:
    os.ftruncate(fd, 0)
finally:
    os.close(fd)
`));
});

test("os.truncate on a writable descriptor does not empty a prefix file", async () => {
    await expectPrefixMutationRejected(cell(`
fd = os.open(path, os.O_RDWR)
try:
    os.truncate(fd, 0)
finally:
    os.close(fd)
`));
});

test("open mode r with a writable opener cannot ftruncate a prefix file", async () => {
    await expectPrefixMutationRejected(cell(`
def opener(name, flags):
    return os.open(name, os.O_RDWR)
with open(path, "r", opener=opener) as handle:
    os.ftruncate(handle.fileno(), 0)
`));
});

test("reopening a prefix descriptor for write cannot truncate it", async () => {
    await expectPrefixMutationRejected(cell(`
fd = os.open(path, os.O_RDWR)
try:
    with open(fd, "w", closefd=False) as handle:
        handle.truncate(0)
finally:
    os.close(fd)
`));
});
