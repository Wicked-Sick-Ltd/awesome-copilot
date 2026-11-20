import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pythonRunner, pythonRunnerEnv } from "./python-runner.mjs";

const python = ["python3", "python"].find((command) => spawnSync(command, ["--version"]).status === 0);
const skip = python ? false : "Python is not installed";
const OLD_TIME = new Date("2001-02-03T04:05:06Z");

function hostPython(code, ...args) {
    const result = spawnSync(python, ["-c", code, ...args], { encoding: "utf8" });
    return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr };
}

const xattrSupported = Boolean(python) && (() => {
    const dir = mkdtempSync(path.join(tmpdir(), "notebook-xattr-probe-"));
    try {
        const file = path.join(dir, "probe");
        writeFileSync(file, "probe");
        return hostPython("import os, sys; os.setxattr(sys.argv[1], 'user.copilot-probe', b'1')", file).ok;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
})();

function runCells(cells) {
    const executionDir = mkdtempSync(path.join(tmpdir(), "copilot-notebook-"));
    return new Promise((resolve, reject) => {
        const child = spawn(python, ["-I", "-c", pythonRunner], {
            cwd: executionDir,
            env: pythonRunnerEnv(executionDir),
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            rmSync(executionDir, { recursive: true, force: true });
            if (code !== 0) {
                reject(new Error(`runner exited with ${code}: ${stderr}`));
                return;
            }
            resolve(JSON.parse(stdout).results);
        });
        child.stdin.end(JSON.stringify({
            cells: cells.map((code, index) => ({ id: `cell-${index}`, code })),
            stopOnError: false,
        }));
    });
}

function outsideFixture(t) {
    const dir = mkdtempSync(path.join(tmpdir(), "notebook-outside-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, "credentials.txt");
    writeFileSync(target, "placeholder");
    utimesSync(target, OLD_TIME, OLD_TIME);
    return { dir, target };
}

function entryExists(file) {
    try {
        lstatSync(file);
        return true;
    } catch {
        return false;
    }
}

function assertRefusedByWorkspace(result) {
    assert.ok(result.error, `expected the cell to be refused, got stdout=${JSON.stringify(result.stdout)}`);
    assert.equal(result.error.ename, "PermissionError", result.error.evalue);
    assert.match(result.error.evalue, /isolated workspace|disabled/);
}

test("Path.touch and os.utime cannot change timestamps outside the workspace", { skip }, async (t) => {
    const { target } = outsideFixture(t);
    const literal = JSON.stringify(target);
    const results = await runCells([
        `import pathlib\npathlib.Path(${literal}).touch()`,
        `import os\nos.utime(${literal}, (0, 0))`,
        `import os\nos.utime(${literal}, ns=(0, 0), follow_symlinks=False)`,
        `import os\nos.utime(os.path.relpath(${literal}), (0, 0))`,
    ]);
    for (const result of results) {
        assertRefusedByWorkspace(result);
    }
    assert.equal(statSync(target).mtime.getTime(), OLD_TIME.getTime());
});

test("extended attributes outside the workspace cannot be set or removed", { skip: skip || (!xattrSupported && "user xattrs unsupported") }, async (t) => {
    const { dir, target } = outsideFixture(t);
    const preset = path.join(dir, "preset.txt");
    writeFileSync(preset, "placeholder");
    assert.ok(hostPython("import os, sys; os.setxattr(sys.argv[1], 'user.copilot-test', b'keep')", preset).ok);
    const results = await runCells([
        `import os\nos.setxattr(${JSON.stringify(target)}, "user.copilot-test", b"1")`,
        `import os\nos.removexattr(${JSON.stringify(preset)}, "user.copilot-test")`,
    ]);
    for (const result of results) {
        assertRefusedByWorkspace(result);
    }
    const listXattrs = "import os, sys; print(','.join(sorted(os.listxattr(sys.argv[1]))))";
    assert.equal(hostPython(listXattrs, target).stdout, "");
    assert.equal(hostPython(listXattrs, preset).stdout, "user.copilot-test");
});

test("file flags outside the workspace cannot be changed", { skip: skip || (!hostPython("import os; assert hasattr(os, 'chflags')").ok && "os.chflags unavailable") }, async (t) => {
    const { target } = outsideFixture(t);
    const results = await runCells([
        `import os, stat\nos.chflags(${JSON.stringify(target)}, stat.UF_NODUMP)`,
        `import os, stat\nos.lchflags(${JSON.stringify(target)}, stat.UF_NODUMP)`,
    ]);
    for (const result of results) {
        assertRefusedByWorkspace(result);
    }
    assert.equal(hostPython("import os, sys; print(os.stat(sys.argv[1]).st_flags)", target).stdout, "0");
});

test("descriptor-based metadata changes cannot reach files outside the workspace", { skip }, async () => {
    const results = await runCells([
        `import os\nfd = os.open(os.__file__, os.O_RDONLY)\nos.utime(fd)`,
        `import os, sys\nif os.utime not in os.supports_dir_fd:\n    raise PermissionError("dir_fd unsupported; isolated workspace")\nfd = os.open(sys.prefix, os.O_RDONLY)\nos.utime(os.path.relpath(os.__file__, sys.prefix), dir_fd=fd)`,
        `import os\nos.open(os.__file__, os.O_WRONLY)`,
    ]);
    for (const result of results) {
        assertRefusedByWorkspace(result);
    }
});

test("links and the working directory cannot be pointed outside the workspace", { skip }, async (t) => {
    const { dir, target } = outsideFixture(t);
    const symlinkOut = path.join(dir, "symlink-out");
    const hardlinkOut = path.join(dir, "hardlink-out");
    const escape = `${"../".repeat(6)}`;
    const results = await runCells([
        `import os\nopen("inside.txt", "w").close()\nos.symlink(os.path.abspath("inside.txt"), ${JSON.stringify(symlinkOut)})`,
        `import os\nopen("inside2.txt", "w").close()\nos.link("inside2.txt", ${JSON.stringify(hardlinkOut)})`,
        [
            "import os",
            `os.makedirs("p1/p2/p3/p4/p5/p6")`,
            `os.symlink("p1/p2/p3/p4/p5/p6", "y")`,
            `os.makedirs("a/b/c/y")`,
            `os.symlink("y/${escape}", "a/b/c/esc")`,
            `os.utime("a/b/c/esc" + ${JSON.stringify(target)}, (0, 0))`,
        ].join("\n"),
        `import os\nos.mkdir("d")\nopen("f", "w").close()\nos.utime("d/../f", (0, 0))`,
        `import os, sys\nos.chdir(sys.prefix)`,
    ]);
    for (const result of results) {
        assertRefusedByWorkspace(result);
    }
    assert.equal(entryExists(symlinkOut), false);
    assert.equal(entryExists(hardlinkOut), false);
    assert.equal(statSync(target).mtime.getTime(), OLD_TIME.getTime());
});

test("metadata and link operations inside the workspace keep working", { skip }, async () => {
    const results = await runCells([[
        "import os, pathlib, shutil, sys, tempfile",
        "ws = os.getcwd()",
        "marker = pathlib.Path('marker.txt')",
        "marker.write_text('x')",
        "os.utime(marker, (0, 0))",
        "marker.touch()",
        "assert marker.stat().st_mtime > 0",
        "os.utime(os.path.join(ws, 'marker.txt'), (5, 5))",
        "assert marker.stat().st_mtime == 5",
        "pathlib.Path('new-marker').touch()",
        "shutil.copy2('marker.txt', pathlib.Path('copy.txt'))",
        "assert os.stat('copy.txt').st_mtime == 5",
        "with tempfile.NamedTemporaryFile(delete=False) as handle:",
        "    os.utime(handle.name, (7, 7))",
        "os.symlink('marker.txt', 'relative-link')",
        "os.symlink(os.path.join(ws, 'marker.txt'), 'absolute-link')",
        "assert pathlib.Path('relative-link').read_text() == 'x'",
        "assert pathlib.Path('absolute-link').read_text() == 'x'",
        "os.link('marker.txt', 'hard.txt')",
        "os.rename('hard.txt', 'hard2.txt')",
        "os.replace('hard2.txt', 'hard3.txt')",
        "os.mkdir('sub')",
        "os.chdir('sub')",
        "pathlib.Path('inner.txt').touch()",
        "os.chdir(ws)",
        "assert os.path.exists('sub/inner.txt')",
        "if hasattr(os, 'setxattr'):",
        "    try:",
        "        os.setxattr('marker.txt', 'user.copilot-test', b'1')",
        "    except PermissionError as error:",
        "        if error.errno is None:",
        "            raise",
        "    except OSError:",
        "        pass",
        "    else:",
        "        os.removexattr('marker.txt', 'user.copilot-test')",
        "shutil.rmtree('sub')",
        "print('ok')",
    ].join("\n")]);
    assert.equal(results[0].error, null, results[0].error?.traceback?.join("\n"));
    assert.equal(results[0].stdout.trim(), "ok");
});
