// Signals dashboard must not follow workshop symlinks or read an unbounded file.
// These tests fail while scanSignals and readStash stat/readFile/writeFile the
// workshop paths with no regular-file check and no byte cap.
//
// Run from the repository root:
//   node --import ./extensions/signals-dashboard/symlink-read-limits.preload.mjs --test ./extensions/signals-dashboard/symlink-read-limits.test.mjs
//
// A signal or stash read has to:
//   - refuse a symbolic link, including one that appears after a metadata check
//   - refuse a path whose real file is outside the workshop (directory symlink)
//   - stop at 1 MiB (MCP_DISCOVERY_MAX_BYTES in extension.mjs) and still return
//   - leave the stash target unchanged
//   - finish when the target never reaches EOF
// A normal small JSON signal inside the workshop must still load.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { armReadTrap } from "./symlink-read-limits.trap-core.mjs";

const CAP = 1024 * 1024;
const preloadPath = fileURLToPath(new URL("./symlink-read-limits.preload.mjs", import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

function git(cwd, args) {
    execFileSync("git", args, {
        cwd,
        stdio: "pipe",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Signals Test",
            GIT_AUTHOR_EMAIL: "signals-test@example.com",
            GIT_COMMITTER_NAME: "Signals Test",
            GIT_COMMITTER_EMAIL: "signals-test@example.com",
        },
    });
}

function signalJson(intent, whatWorked) {
    return JSON.stringify({
        signal_type: "execution",
        intent,
        patterns: { what_worked: whatWorked },
    });
}

function oversizeSignal(marker) {
    const prefix = '{"signal_type":"execution","intent":"';
    const suffix = `","patterns":{"what_worked":"${marker}"}}`;
    return prefix + "a".repeat(CAP) + marker + suffix;
}

function oversizeStash(marker) {
    const prefix = '[{"name":"';
    const suffix = `","stashedAt":"${new Date().toISOString()}"}]`;
    return prefix + "b".repeat(CAP) + marker + suffix;
}

async function loadCanvas() {
    await import("./extension.mjs");
    const canvas = globalThis.__signalsDashboardCanvas;
    if (!canvas?.open || !Array.isArray(canvas.actions)) {
        throw new Error("signals dashboard canvas was not registered");
    }
    return canvas;
}

function action(canvas, name) {
    const found = canvas.actions.find((item) => item.name === name);
    if (!found) throw new Error(`missing canvas action ${name}`);
    return found;
}

async function withDashboard(workshopDir, fn) {
    const canvas = await loadCanvas();
    const instanceId = `signals-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    const ctx = { instanceId, input: { workshopDir } };
    try {
        const opened = await canvas.open(ctx);
        return await fn({ canvas, ctx, opened });
    } finally {
        await canvas.onClose?.(ctx);
    }
}

async function readDashboard(workshopDir) {
    return withDashboard(workshopDir, async ({ canvas, ctx, opened }) => {
        const response = await fetch(opened.url);
        const html = await response.text();
        const refreshed = await action(canvas, "refresh").handler(ctx);
        return { response, html, refreshed, opened, canvas, ctx };
    });
}

function assertNoMarker(html, refreshed, marker) {
    const blob = JSON.stringify(refreshed);
    if (html.includes(marker) || blob.includes(marker)) {
        throw new Error(`workshop read surfaced ${marker}`);
    }
}

function assertHas(html, refreshed, marker) {
    const blob = JSON.stringify(refreshed);
    if (!html.includes(marker) || !blob.includes(marker)) {
        throw new Error(`expected a normal in-workshop signal ${marker}`);
    }
}

async function makeRoot() {
    return mkdtemp(join(tmpdir(), "signals-symlink-"));
}

async function clonedWorkshop() {
    const root = await makeRoot();
    const origin = join(root, "origin");
    const outside = join(root, "outside");
    const workshop = join(root, "clone");
    await mkdir(join(origin, "desks/example/.signals"), { recursive: true });
    await mkdir(join(origin, "desks/ok/.signals"), { recursive: true });
    await mkdir(join(origin, "desks/escaped"), { recursive: true });
    await mkdir(join(origin, "classroom/classdesk/.signals"), { recursive: true });
    await mkdir(join(origin, "classroom/classescape"), { recursive: true });
    await mkdir(outside, { recursive: true });

    const relativeTarget = join(outside, "relative-signal.json");
    const absoluteTarget = join(outside, "absolute-signal.json");
    const deskDir = join(outside, "desk-signals");
    const classDir = join(outside, "class-signals");
    await mkdir(deskDir, { recursive: true });
    await mkdir(classDir, { recursive: true });
    await writeFile(relativeTarget, signalJson("DESK_SIGNAL_LEAK_INTENT", "DESK_SIGNAL_LEAK_WORKED"));
    await writeFile(absoluteTarget, signalJson("CLASS_SIGNAL_LEAK_INTENT", "CLASS_SIGNAL_LEAK_WORKED"));
    await writeFile(join(deskDir, "note.json"), signalJson("DIR_SIGNAL_LEAK_INTENT", "DIR_SIGNAL_LEAK_WORKED"));
    await writeFile(join(classDir, "note.json"), signalJson("CLASS_DIR_SIGNAL_LEAK_INTENT", "CLASS_DIR_SIGNAL_LEAK_WORKED"));
    await writeFile(join(origin, "desks/ok/.signals/ok.json"), signalJson("LEGIT_SIGNAL_INTENT", "LEGIT_SIGNAL_WORKED"));

    const deskLink = join(origin, "desks/example/.signals/bomb.json");
    symlinkSync(relative(dirname(deskLink), relativeTarget), deskLink);
    symlinkSync(absoluteTarget, join(origin, "classroom/classdesk/.signals/bomb.json"));
    symlinkSync(deskDir, join(origin, "desks/escaped/.signals"));
    symlinkSync(classDir, join(origin, "classroom/classescape/.signals"));

    const stashTarget = join(outside, "stash.json");
    const stashedAt = new Date().toISOString();
    await writeFile(stashTarget, JSON.stringify([{ name: "LIVE_STASH_LEAK_NAME", stashedAt }], null, 2));
    symlinkSync(relative(origin, stashTarget), join(origin, ".desk-stash.json"));

    git(origin, ["init"]);
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-m", "workshop"]);
    git(root, ["clone", origin, "clone"]);
    return { root, workshop, outside };
}

function requireSymlink(path) {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
        throw new Error(`expected a checked-out symlink at ${path}`);
    }
}

if (process.env.SIGNALS_SYMLINK_PROBE === "hang") {
    try {
        await runHangProbe();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
    process.exit(0);
}

const { describe, test } = await import("node:test");
const assert = await import("node:assert/strict");

describe("signals dashboard symlink and size limits", { concurrency: 1 }, () => {
    test("test harness swaps an armed path before a following read", async () => {
        const wrapped = await import("./symlink-read-limits.wrapped-import.mjs");
        const root = await makeRoot();
        try {
            const file = join(root, "note.json");
            const outside = join(root, "outside.json");
            await writeFile(file, "benign");
            await writeFile(outside, "SWAPPED_TARGET");
            const disarm = armReadTrap(file, outside);
            try {
                const text = await wrapped.readFile(file, "utf8");
                assert.equal(text, "SWAPPED_TARGET");
                assert.equal(lstatSync(file).isSymbolicLink(), true);
            } finally {
                disarm();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("a cloned workshop symlink is not returned by the dashboard or refresh", async () => {
        const { root, workshop } = await clonedWorkshop();
        try {
            const deskLink = join(workshop, "desks/example/.signals/bomb.json");
            const classLink = join(workshop, "classroom/classdesk/.signals/bomb.json");
            const stashLink = join(workshop, ".desk-stash.json");
            requireSymlink(deskLink);
            requireSymlink(classLink);
            requireSymlink(stashLink);
            assert.match(readFileSync(deskLink, "utf8"), /DESK_SIGNAL_LEAK_INTENT/);
            assert.match(readFileSync(classLink, "utf8"), /CLASS_SIGNAL_LEAK_INTENT/);

            const { response, html, refreshed } = await readDashboard(workshop);
            assert.equal(response.status, 200);
            assertHas(html, refreshed, "LEGIT_SIGNAL_INTENT");
            for (const marker of [
                "DESK_SIGNAL_LEAK_INTENT",
                "DESK_SIGNAL_LEAK_WORKED",
                "CLASS_SIGNAL_LEAK_INTENT",
                "CLASS_SIGNAL_LEAK_WORKED",
                "DIR_SIGNAL_LEAK_INTENT",
                "DIR_SIGNAL_LEAK_WORKED",
                "CLASS_DIR_SIGNAL_LEAK_INTENT",
                "CLASS_DIR_SIGNAL_LEAK_WORKED",
                "LIVE_STASH_LEAK_NAME",
            ]) {
                assertNoMarker(html, refreshed, marker);
            }
            const outsideStash = readFileSync(join(root, "outside/stash.json"), "utf8");
            assert.match(outsideStash, /LIVE_STASH_LEAK_NAME/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("an expired stash symlink is not rewritten when the dashboard opens", async () => {
        const root = await makeRoot();
        try {
            const workshop = join(root, "workshop");
            const outside = join(root, "outside-stash.json");
            const original = JSON.stringify([
                { name: "EXPIRED_LEAK_DESK", stashedAt: "2000-01-01T00:00:00.000Z" },
            ], null, 2);
            await mkdir(join(workshop, "desks/ok/.signals"), { recursive: true });
            await writeFile(join(workshop, "desks/ok/.signals/ok.json"), signalJson("LEGIT_SIGNAL_INTENT", "LEGIT_SIGNAL_WORKED"));
            await writeFile(outside, original);
            symlinkSync(outside, join(workshop, ".desk-stash.json"));

            const { response, html, refreshed } = await readDashboard(workshop);
            assert.equal(response.status, 200);
            assertHas(html, refreshed, "LEGIT_SIGNAL_INTENT");
            assert.equal(readFileSync(outside, "utf8"), original);
            assertNoMarker(html, refreshed, "EXPIRED_LEAK_DESK");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("stash and restore do not write through a stash symlink", async () => {
        const root = await makeRoot();
        try {
            const workshop = join(root, "workshop");
            const outside = join(root, "outside-stash.json");
            const original = JSON.stringify([
                { name: "LIVE_EXISTING", stashedAt: new Date().toISOString() },
            ], null, 2);
            await mkdir(join(workshop, "desks/example"), { recursive: true });
            await writeFile(outside, original);
            symlinkSync(outside, join(workshop, ".desk-stash.json"));

            await withDashboard(workshop, async ({ canvas, ctx, opened }) => {
                await action(canvas, "stash").handler({ ...ctx, input: { deskName: "example" } });
                assert.equal(readFileSync(outside, "utf8"), original);

                await action(canvas, "restore").handler({ ...ctx, input: { deskName: "LIVE_EXISTING" } });
                assert.equal(readFileSync(outside, "utf8"), original);

                const page = await fetch(opened.url);
                const html = await page.text();
                const token = JSON.parse(html.match(/const WORKSHOP_TOKEN = (".*");/)[1]);
                const headers = { "x-workshop-token": token };
                const stashed = await fetch(new URL("/api/stash/example", opened.url), { method: "POST", headers });
                assert.equal(stashed.status, 200);
                assert.equal(readFileSync(outside, "utf8"), original);
                const restored = await fetch(new URL("/api/restore/LIVE_EXISTING", opened.url), { method: "POST", headers });
                assert.equal(restored.status, 200);
                assert.equal(readFileSync(outside, "utf8"), original);
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("signal and stash reads stop after one megabyte", async () => {
        const root = await makeRoot();
        try {
            const workshop = join(root, "workshop");
            const outsideSignal = join(root, "big-signal.json");
            const outsideStash = join(root, "big-stash.json");
            await mkdir(join(workshop, "desks/ok/.signals"), { recursive: true });
            await mkdir(join(workshop, "desks/big/.signals"), { recursive: true });
            await mkdir(join(workshop, "classroom/linked/.signals"), { recursive: true });
            await writeFile(join(workshop, "desks/ok/.signals/ok.json"), signalJson("LEGIT_SIGNAL_INTENT", "LEGIT_SIGNAL_WORKED"));
            await writeFile(join(workshop, "desks/big/.signals/big.json"), oversizeSignal("PAST_CAP_SIGNAL_MARKER"));
            await writeFile(outsideSignal, oversizeSignal("PAST_CAP_LINK_MARKER"));
            await writeFile(outsideStash, oversizeStash("PAST_CAP_STASH_MARKER"));
            symlinkSync(outsideSignal, join(workshop, "classroom/linked/.signals/bomb.json"));
            symlinkSync(outsideStash, join(workshop, ".desk-stash.json"));
            assert.ok(readFileSync(outsideSignal).length > CAP);
            assert.ok(readFileSync(join(workshop, "desks/big/.signals/big.json")).length > CAP);

            const { response, html, refreshed } = await readDashboard(workshop);
            assert.equal(response.status, 200);
            assertHas(html, refreshed, "LEGIT_SIGNAL_INTENT");
            for (const marker of ["PAST_CAP_SIGNAL_MARKER", "PAST_CAP_LINK_MARKER", "PAST_CAP_STASH_MARKER"]) {
                assertNoMarker(html, refreshed, marker);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("a metadata check cannot be followed by a path read that sees a new symlink", async () => {
        const root = await makeRoot();
        try {
            const workshop = join(root, "workshop");
            const signal = join(workshop, "desks/swap/.signals/bomb.json");
            const outsideSignal = join(root, "outside-signal.json");
            const stash = join(workshop, ".desk-stash.json");
            const outsideStash = join(root, "outside-stash.txt");
            await mkdir(dirname(signal), { recursive: true });
            await mkdir(join(workshop, "desks/ok/.signals"), { recursive: true });
            await writeFile(join(workshop, "desks/ok/.signals/ok.json"), signalJson("LEGIT_SIGNAL_INTENT", "LEGIT_SIGNAL_WORKED"));
            await writeFile(signal, signalJson("TOCTOU_BENIGN_INTENT", "TOCTOU_BENIGN_WORKED"));
            await writeFile(outsideSignal, signalJson("TOCTOU_SIGNAL_LEAK", "TOCTOU_SIGNAL_WORKED"));
            await writeFile(stash, "[]");
            const originalStash = "ORIGINAL_OUTSIDE_STASH_BYTES";
            await writeFile(outsideStash, originalStash);

            const disarmSignal = armReadTrap(signal, outsideSignal);
            const disarmStash = armReadTrap(stash, outsideStash);
            try {
                const { response, html, refreshed, canvas, ctx } = await readDashboard(workshop);
                assert.equal(response.status, 200);
                assertHas(html, refreshed, "LEGIT_SIGNAL_INTENT");
                assertNoMarker(html, refreshed, "TOCTOU_SIGNAL_LEAK");
                assertNoMarker(html, refreshed, "TOCTOU_SIGNAL_WORKED");
                await action(canvas, "stash").handler({ ...ctx, input: { deskName: "ok" } });
                assert.equal(readFileSync(outsideStash, "utf8"), originalStash);
            } finally {
                disarmSignal();
                disarmStash();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("opening the dashboard finishes when a signal and the stash are symlinks to fifos", async () => {
        const child = spawn(process.execPath, ["--import", preloadPath, selfPath], {
            env: { ...process.env, SIGNALS_SYMLINK_PROBE: "hang" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
        const [code, signal] = await new Promise((resolve) => {
            child.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
        });
        clearTimeout(timer);
        assert.equal(
            signal,
            null,
            `dashboard did not finish and was killed (${signal})\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`,
        );
        assert.equal(code, 0, `hang probe exited ${code}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`);
    });
});

async function runHangProbe() {
    const killTimer = setTimeout(() => process.exit(9), 30000);
    const root = await makeRoot();
    try {
        const fifoSignal = join(root, "signal.fifo");
        const fifoStash = join(root, "stash.fifo");
        for (const fifo of [fifoSignal, fifoStash]) {
            const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
            if (made.status !== 0) throw new Error(made.stderr || "mkfifo failed");
        }
        const origin = join(root, "origin");
        const workshop = join(root, "clone");
        await mkdir(join(origin, "desks/example/.signals"), { recursive: true });
        await mkdir(join(origin, "desks/ok/.signals"), { recursive: true });
        await writeFile(join(origin, "desks/ok/.signals/ok.json"), signalJson("HANG_LEGIT_INTENT", "HANG_LEGIT_WORKED"));
        symlinkSync(fifoSignal, join(origin, "desks/example/.signals/bomb.json"));
        symlinkSync(fifoStash, join(origin, ".desk-stash.json"));
        git(origin, ["init"]);
        git(origin, ["add", "-A"]);
        git(origin, ["commit", "-m", "workshop"]);
        git(root, ["clone", origin, "clone"]);
        requireSymlink(join(workshop, "desks/example/.signals/bomb.json"));
        requireSymlink(join(workshop, ".desk-stash.json"));

        const { response, html, refreshed } = await readDashboard(workshop);
        if (response.status !== 200) process.exit(2);
        const blob = JSON.stringify(refreshed);
        if (!html.includes("HANG_LEGIT_INTENT") || !blob.includes("HANG_LEGIT_INTENT")) process.exit(3);
        process.exit(0);
    } finally {
        clearTimeout(killTimer);
        await rm(root, { recursive: true, force: true });
    }
}
