import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeCommands, sandboxUnavailableExitCode, spawnPythonRunner } from "./python-runner.mjs";

const posixOnly = { skip: process.platform === "win32" ? "named pipes are not filesystem nodes on Windows" : false };
const mkfifoBinary = ["/usr/bin/mkfifo", "/bin/mkfifo"].find((candidate) => existsSync(candidate));

function runCells(cells) {
    const executionDir = mkdtempSync(path.join(os.tmpdir(), "copilot-notebook-test-"));
    return new Promise((resolve, reject) => {
        const child = spawnPythonRunner("python3", executionDir, false);
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            clearTimeout(timer);
            rmSync(executionDir, { recursive: true, force: true });
            let results = null;
            try {
                results = JSON.parse(stdout).results;
            } catch {
                // The runner refused to start or the cell replaced the process.
            }
            resolve({ code, stdout, stderr, results });
        });
        child.stdin.end(JSON.stringify({
            cells: cells.map((code, index) => ({ id: `cell-${index}`, code })),
            stopOnError: true,
        }));
    });
}

function outsideTarget(t) {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "notebook-outside-"));
    t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
    return path.join(outsideDir, "pipe");
}

function assertNoNode(target) {
    assert.throws(() => lstatSync(target), { code: "ENOENT" }, `${target} was created outside the execution directory`);
}

test("os.mkfifo cannot create a named pipe outside the execution directory", posixOnly, async (t) => {
    const target = outsideTarget(t);
    const run = await runCells([`import os\nos.mkfifo(${JSON.stringify(target)})`]);
    assertNoNode(target);
    if (run.results) {
        assert.ok(run.results[0].error, "the cell should fail");
    }
});

test("os.mknod cannot create a named pipe outside the execution directory", posixOnly, async (t) => {
    const target = outsideTarget(t);
    const run = await runCells([`import os, stat\nos.mknod(${JSON.stringify(target)}, 0o600 | stat.S_IFIFO)`]);
    assertNoNode(target);
    if (run.results) {
        assert.ok(run.results[0].error, "the cell should fail");
    }
});

test("an exec'd program cannot create a named pipe outside the execution directory", {
    skip: posixOnly.skip || (mkfifoBinary ? false : "mkfifo is not installed"),
}, async (t) => {
    const target = outsideTarget(t);
    const script = `${mkfifoBinary} '${target}'; printf '{"results": []}'`;
    await runCells([`import os\nos.execv("/bin/sh", ["sh", "-c", ${JSON.stringify(script)}])`]);
    assertNoNode(target);
});

test("cells still run and can write inside the execution directory", posixOnly, async (t) => {
    const run = await runCells([
        "import os, pathlib\npathlib.Path('out.txt').write_text('ok')\nos.mkfifo('local-pipe')",
        "sorted(os.listdir('.'))",
    ]);
    if (run.code === sandboxUnavailableExitCode) {
        t.skip(`this host has no filesystem sandbox: ${run.stderr.trim()}`);
        return;
    }
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.results[0].error, null);
    assert.equal(run.results[1].resultData["text/plain"], "['local-pipe', 'out.txt']");
});

test("notebook metadata cannot select an arbitrary runtime command", () => {
    assert.deepEqual(runtimeCommands(undefined), ["python3", "python"]);
    assert.deepEqual(runtimeCommands("python3"), ["python3"]);
    assert.deepEqual(runtimeCommands("python"), ["python"]);
    for (const runtime of ["/tmp/evil", "./evil", "sh", "python3 -c", "mkfifo"]) {
        assert.equal(runtimeCommands(runtime), null, runtime);
    }
});
