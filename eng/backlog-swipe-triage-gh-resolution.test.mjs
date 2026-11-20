// Fails while Backlog Swipe Triage starts the bare command "gh" with the
// untrusted session directory as the child cwd. On Windows, libuv 1.51.0
// (Node 22.23.4 deps/uv/src/win/process.c search_path) resolves a bare name
// from that cwd as "<name>.com" then "<name>.exe" before PATH, when
// NoDefaultCurrentDirectoryInExePath is unset. These tests pass once every
// gh spawn uses an executable path outside that directory and does not go
// through a shell.
//
// Run: node --test eng/backlog-swipe-triage-gh-resolution.test.mjs

import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const registered = register(new URL("./backlog-swipe-triage-sdk-hook.mjs", import.meta.url));
if (registered && typeof registered.then === "function") {
    await registered;
}

const spawns = [];
const originalSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function recordSpawn(options) {
    spawns.push({
        file: options.file,
        cwd: options.cwd ?? null,
        args: Array.isArray(options.args) ? [...options.args] : [],
        shell: options.shell ?? false,
        // libuv reads this on the parent at uv_spawn, not from the child env.
        currentDirectorySearch: process.env.NoDefaultCurrentDirectoryInExePath === undefined,
    });
    return originalSpawn.call(this, options);
};

const extensionDir = new URL("../extensions/backlog-swipe-triage/", import.meta.url);
const artifactsDir = new URL("./artifacts/", extensionDir);
const plantedNames = ["gh", "gh.com", "gh.exe", "gh.cmd", "gh.bat"];
const tempDirs = [];
let canvas;
let binDir;
let savedPath;

function bareExecutableName(file) {
    return typeof file === "string" && file.length > 0 && !/[\\/]/.test(file) && !/^[A-Za-z]:/.test(file);
}

function lookupDirectory(cwd) {
    if (typeof cwd === "string" && cwd.trim()) {
        return path.resolve(cwd);
    }
    return path.resolve(process.cwd());
}

function pathIsInside(candidate, parent) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// True when this spawn record is the one libuv would satisfy from the
// planted repository instead of from PATH.
function spawnResolvesUntrustedExecutable(spawn, untrustedDir) {
    if (spawn.shell) {
        return true;
    }
    const repo = path.resolve(untrustedDir);
    const cwd = lookupDirectory(spawn.cwd);
    if (bareExecutableName(spawn.file)) {
        return spawn.currentDirectorySearch && cwd === repo;
    }
    return pathIsInside(path.resolve(cwd, spawn.file), repo);
}

function ghSpawns() {
    return spawns.filter((spawn) => {
        const base = path.basename(String(spawn.file ?? "")).toLowerCase();
        return plantedNames.includes(base) || spawn.shell;
    });
}

async function loadCanvas() {
    if (!canvas) {
        await import("../extensions/backlog-swipe-triage/extension.mjs");
        canvas = globalThis.__backlogSwipeTriageCanvas;
    }
    if (!canvas?.open) {
        throw new Error("Canvas open handler was not registered.");
    }
    return canvas;
}

async function makeRepo() {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "backlog-gh-repo-"));
    tempDirs.push(repoDir);
    const marker = path.join(repoDir, "planted-marker.txt");
    const script = [
        "#!/bin/sh",
        "if [ -n \"${PLANTED_MARKER:-}\" ]; then",
        "  printf 'executed\\n' > \"$PLANTED_MARKER\"",
        "fi",
        "printf '%s\\n' '[]'",
        "exit 0",
        "",
    ].join("\n");
    for (const name of plantedNames) {
        const file = path.join(repoDir, name);
        await writeFile(file, script, "utf8");
        await chmod(file, 0o755);
    }
    return { repoDir, marker };
}

async function markerWritten(marker) {
    try {
        const text = await readFile(marker, "utf8");
        return text.length > 0;
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function request(instanceId, input = {}, workingDirectory = undefined) {
    const session = {};
    if (workingDirectory !== undefined) {
        session.workingDirectory = workingDirectory;
    }
    return {
        sessionId: "test-session",
        extensionId: "backlog-swipe-triage",
        canvasId: "backlog-swipe-triage",
        instanceId,
        input,
        session,
    };
}

const seededItem = {
    id: "issue-7",
    title: "#7 Example",
    repo: "octo/example",
    number: "7",
};

async function openCanvas(options) {
    const opened = await canvas.open(request(options.instanceId, options.input, options.workingDirectory));
    return opened;
}

async function invoke(actionName, input, workingDirectory) {
    const handler = canvas.actionHandlers.get(actionName);
    assert.equal(typeof handler, "function", `missing action ${actionName}`);
    return handler(request(`action-${actionName}-${input.boardId}`, input, workingDirectory));
}

function assertTrustedGh(repoDir, expectedArgs) {
    const matches = ghSpawns().filter((spawn) => expectedArgs.every((arg) => spawn.args.includes(arg)));
    assert.ok(
        matches.length > 0,
        `expected a gh spawn containing ${expectedArgs.join(" ")}, saw ${JSON.stringify(spawns)}`,
    );
    for (const spawn of matches) {
        assert.equal(
            spawnResolvesUntrustedExecutable(spawn, repoDir),
            false,
            `gh would be resolved from the untrusted repository (file=${spawn.file} cwd=${spawn.cwd} shell=${spawn.shell})`,
        );
    }
}

async function withRepo(run) {
    const opened = [];
    const { repoDir, marker } = await makeRepo();
    process.env.PLANTED_MARKER = marker;
    spawns.length = 0;
    try {
        await run({ repoDir, marker, opened });
        assert.equal(await markerWritten(marker), false, "a gh program planted in the repository executed");
    } finally {
        delete process.env.PLANTED_MARKER;
        for (const instanceId of opened) {
            if (canvas?.onClose) {
                await canvas.onClose(request(instanceId));
            }
        }
    }
}

test("canvas open syncs issues without executing gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "open-sync";
        opened.push(instanceId);
        const openedCanvas = await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "open-sync", repo: "octo/example" },
        });
        assert.equal(typeof openedCanvas.url, "string");
        assertTrustedGh(repoDir, ["issue", "list"]);
    });
});

test("canvas open resolves the repository with gh before listing issues", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "open-repo-view";
        opened.push(instanceId);
        await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "open-repo-view" },
        });
        assertTrustedGh(repoDir, ["repo", "view"]);
        assertTrustedGh(repoDir, ["issue", "list"]);
    });
});

test("sync_from_repo does not resolve gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "action-sync-open";
        opened.push(instanceId);
        await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: {
                boardId: "action-sync",
                syncFromRepo: false,
                items: [seededItem],
            },
        });
        spawns.length = 0;
        await invoke("sync_from_repo", { boardId: "action-sync" }, repoDir);
        assertTrustedGh(repoDir, ["issue", "list"]);
    });
});

test("apply_decision close does not resolve gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "action-close-open";
        opened.push(instanceId);
        await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "action-close", syncFromRepo: false, items: [seededItem] },
        });
        spawns.length = 0;
        await invoke(
            "apply_decision",
            { boardId: "action-close", itemId: "issue-7", decision: "close", note: "triage close" },
            repoDir,
        );
        assertTrustedGh(repoDir, ["issue", "close"]);
    });
});

test("apply_decision comment does not resolve gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "action-comment-open";
        opened.push(instanceId);
        await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "action-comment", syncFromRepo: false, items: [seededItem] },
        });
        spawns.length = 0;
        await invoke(
            "apply_decision",
            {
                boardId: "action-comment",
                itemId: "issue-7",
                decision: "needs_info",
                note: "need a repro",
                commentOnIssue: true,
            },
            repoDir,
        );
        assertTrustedGh(repoDir, ["issue", "comment"]);
    });
});

test("HTTP sync does not resolve gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "http-sync";
        opened.push(instanceId);
        const openedCanvas = await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "http-sync", syncFromRepo: false, items: [seededItem] },
        });
        spawns.length = 0;
        const response = await fetch(new URL("/sync", openedCanvas.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assertTrustedGh(repoDir, ["issue", "list"]);
    });
});

test("HTTP close does not resolve gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "http-close";
        opened.push(instanceId);
        const openedCanvas = await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "http-close", syncFromRepo: false, items: [seededItem] },
        });
        spawns.length = 0;
        const response = await fetch(new URL("/decision", openedCanvas.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ itemId: "issue-7", decision: "close", note: "triage close" }),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assertTrustedGh(repoDir, ["issue", "close"]);
    });
});

test("HTTP comment does not resolve gh from the session directory", async () => {
    await loadCanvas();
    await withRepo(async ({ repoDir, opened }) => {
        const instanceId = "http-comment";
        opened.push(instanceId);
        const openedCanvas = await openCanvas({
            instanceId,
            workingDirectory: repoDir,
            input: { boardId: "http-comment", syncFromRepo: false, items: [seededItem] },
        });
        spawns.length = 0;
        const response = await fetch(new URL("/decision", openedCanvas.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                itemId: "issue-7",
                decision: "needs_info",
                note: "need a repro",
                quickResponse: true,
            }),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assertTrustedGh(repoDir, ["issue", "comment"]);
    });
});

test("missing session directory still does not resolve gh from process.cwd()", async () => {
    await loadCanvas();
    const previous = process.cwd();
    await withRepo(async ({ repoDir, opened }) => {
        process.chdir(repoDir);
        const instanceId = "cwd-fallback";
        opened.push(instanceId);
        await openCanvas({
            instanceId,
            input: { boardId: "cwd-fallback", repo: "octo/example" },
        });
        assertTrustedGh(repoDir, ["issue", "list"]);
    }).finally(() => {
        process.chdir(previous);
    });
});

before(async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), "backlog-gh-bin-"));
    tempDirs.push(binDir);
    const gh = path.join(binDir, "gh");
    await writeFile(
        gh,
        [
            "#!/bin/sh",
            "set -u",
            "cmd1=${1-}",
            "cmd2=${2-}",
            "if [ \"$cmd1\" = \"repo\" ] && [ \"$cmd2\" = \"view\" ]; then",
            "  printf '%s\\n' '{\"nameWithOwner\":\"octo/example\"}'",
            "  exit 0",
            "fi",
            "if [ \"$cmd1\" = \"issue\" ] && [ \"$cmd2\" = \"list\" ]; then",
            "  printf '%s\\n' '[]'",
            "  exit 0",
            "fi",
            "if [ \"$cmd1\" = \"issue\" ] && [ \"$cmd2\" = \"close\" ]; then",
            "  printf '%s\\n' closed",
            "  exit 0",
            "fi",
            "if [ \"$cmd1\" = \"issue\" ] && [ \"$cmd2\" = \"comment\" ]; then",
            "  printf '%s\\n' commented",
            "  exit 0",
            "fi",
            "printf 'unexpected gh argv:' >&2",
            "printf ' %s' \"$@\" >&2",
            "printf '\\n' >&2",
            "exit 1",
            "",
        ].join("\n"),
        "utf8",
    );
    await chmod(gh, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    await mkdir(artifactsDir, { recursive: true });
});

after(async () => {
    if (savedPath === undefined) {
        delete process.env.PATH;
    } else {
        process.env.PATH = savedPath;
    }
    await rm(artifactsDir, { recursive: true, force: true });
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
