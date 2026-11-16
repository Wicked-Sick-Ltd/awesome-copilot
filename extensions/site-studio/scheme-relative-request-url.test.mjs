// These tests fail while Site Studio's loopback server lets new URL() throw
// out of handleApi. They pass once that constructor failure becomes HTTP 400
// and the extension process stays up.
//
// Run from the repository root:
//   node --test --test-concurrency=1 extensions/site-studio/scheme-relative-request-url.test.mjs

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, "extension.mjs");
const harnessPath = path.join(here, "scheme-relative-request-url.harness.mjs");
const artifactsDir = path.join(here, "artifacts");
const artifactsExisted = exists(artifactsDir);

function exists(target) {
    try {
        readFileSync(target);
        return true;
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return false;
        }
        if (error && error.code === "EISDIR") {
            return true;
        }
        throw error;
    }
}

function runHarness(mode) {
    const markerDir = mkdtempSync(path.join(tmpdir(), "site-studio-url-"));
    const markerPath = path.join(markerDir, "state-before.txt");
    const childEnv = { ...process.env, COPILOT_WORKSPACE_BRANCH: "scheme-relative-test" };
    delete childEnv.NODE_OPTIONS;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [harnessPath, mode, markerPath, extensionPath], {
            cwd: here,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, 20000);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            let marker = "";
            try {
                marker = readFileSync(markerPath, "utf8");
            } catch {
                marker = "";
            }
            rmSync(markerDir, { recursive: true, force: true });
            resolve({ code, signal, stdout, stderr, marker });
        });
    });
}

function assertStateUnchanged(result) {
    const [before, stateFile] = result.marker.split("\n");
    assert.ok(before && stateFile, `harness did not record the state file before the request\n${format(result)}`);
    const after = createHash("sha256").update(readFileSync(stateFile)).digest("hex");
    assert.equal(after, before, `state file changed before the invalid URL was refused\n${format(result)}`);
}

function format(result) {
    return `exit=${result.code} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

test("scheme-relative request URLs return 400 and do not reject", async () => {
    const result = await runHarness("survive");
    assertStateUnchanged(result);
    assert.equal(result.code, 0, format(result));
    assert.match(result.stdout, /HEALTHY 200/);
    assert.match(result.stdout, /RESULT ok/);
    assert.equal(result.stderr, "");
});

test("scheme-relative GET // does not terminate the extension process", async () => {
    const result = await runHarness("default-exit");
    assertStateUnchanged(result);
    assert.equal(result.code, 0, format(result));
    assert.match(result.stdout, /HEALTHY 200/);
    assert.match(result.stdout, /RESULT ok/);
    assert.doesNotMatch(result.stderr, /Invalid URL|UnhandledPromiseRejection|unhandledRejection/i);
});

test.after(() => {
    if (!artifactsExisted) {
        rmSync(artifactsDir, { recursive: true, force: true });
    }
});
