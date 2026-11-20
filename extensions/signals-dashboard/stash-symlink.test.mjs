import test from "node:test";
import assert from "node:assert/strict";
import {
    linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const STASH_FILE = ".desk-stash.json";
const OUTSIDE_BODY = "# shell profile outside the workshop\nexport EDITOR=vi\n";

async function loadDashboard(t) {
    const root = mkdtempSync(join(tmpdir(), "workshop-stash-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const workshopDir = join(home, "projects", "workshop");
    mkdirSync(join(workshopDir, "desks", "alpha"), { recursive: true });

    const imports = new Map();
    for (const specifier of [
        "node:http", "node:fs", "node:fs/promises", "node:path", "node:child_process", "node:crypto",
        "./launch-profile.mjs", "./local-delegation.mjs",
    ]) {
        imports.set(specifier, await import(specifier.startsWith(".")
            ? new URL(specifier, import.meta.url).href : specifier));
    }
    let canvas;
    const context = vm.createContext({
        process: { ...process, env: { ...process.env, HOME: home, USERPROFILE: home } },
        Buffer, URL, console, setTimeout, clearTimeout,
    });
    const module = new vm.SourceTextModule(
        readFileSync(new URL("./extension.mjs", import.meta.url), "utf8"),
        { context },
    );
    await module.link((specifier) => {
        let exports;
        if (specifier === "@github/copilot-sdk/extension") {
            exports = {
                createCanvas: (definition) => definition,
                joinSession: async (options) => { [canvas] = options.canvases; return {}; },
            };
        } else {
            exports = imports.get(specifier);
            if (specifier === "./local-delegation.mjs") {
                exports = {
                    ...exports,
                    resolveLocalDelegationAvailability: () => ({ available: false, reason: "test fixture" }),
                };
            }
        }
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();

    const instanceId = `stash-test-${Math.random().toString(16).slice(2)}`;
    t.after(() => canvas.onClose({ instanceId }));
    const opened = await canvas.open({ instanceId, input: { workshopDir } });
    const action = (name, input = {}) => canvas.actions.find((a) => a.name === name)
        .handler({ instanceId, input });
    return { home, workshopDir, url: opened.url, action };
}

// Mirrors the attack: a committed .desk-stash.json that is a relative symlink
// two folders up, landing on a file in the user's home directory.
function plantStashSymlink(t, home, workshopDir, body = OUTSIDE_BODY) {
    const victim = join(home, ".profile");
    writeFileSync(victim, body);
    try {
        symlinkSync(join("..", "..", ".profile"), join(workshopDir, STASH_FILE));
    } catch (error) {
        if (process.platform === "win32") {
            t.skip(`symlink creation unavailable: ${error.code}`);
            return null;
        }
        throw error;
    }
    return victim;
}

function stashEntries(workshopDir) {
    const fp = join(workshopDir, STASH_FILE);
    assert.equal(lstatSync(fp).isSymbolicLink(), false, "stash file must be a regular file in the workshop");
    return JSON.parse(readFileSync(fp, "utf8")).map((e) => e.name);
}

function noTempFilesLeft(workshopDir) {
    assert.deepEqual(readdirSync(workshopDir).filter((n) => n.includes(".tmp")), []);
}

test("stash action does not write through a symlinked .desk-stash.json", async (t) => {
    const { home, workshopDir, action } = await loadDashboard(t);
    const victim = plantStashSymlink(t, home, workshopDir);
    if (!victim) return;

    const result = await action("stash", { deskName: "alpha" });

    assert.equal(readFileSync(victim, "utf8"), OUTSIDE_BODY, "file outside the workshop was overwritten");
    assert.equal(result.ok, true);
    assert.deepEqual(stashEntries(workshopDir), ["alpha"]);
    noTempFilesLeft(workshopDir);
});

test("restore action does not write through a symlinked .desk-stash.json", async (t) => {
    const { home, workshopDir, action } = await loadDashboard(t);
    const victim = plantStashSymlink(t, home, workshopDir);
    if (!victim) return;

    const result = await action("restore", { deskName: "alpha" });

    assert.equal(readFileSync(victim, "utf8"), OUTSIDE_BODY, "file outside the workshop was overwritten");
    assert.equal(result.ok, true);
    assert.deepEqual(stashEntries(workshopDir), []);
});

test("POST /api/stash does not write through a symlinked .desk-stash.json", async (t) => {
    const { home, workshopDir, url, action } = await loadDashboard(t);
    const victim = plantStashSymlink(t, home, workshopDir);
    if (!victim) return;

    const page = await (await fetch(url)).text();
    const token = JSON.parse(page.match(/const WORKSHOP_TOKEN = ("[^"]+");/)[1]);
    const res = await fetch(new URL("/api/stash/alpha", url), {
        method: "POST", headers: { "x-workshop-token": token },
    });

    assert.equal(readFileSync(victim, "utf8"), OUTSIDE_BODY, "file outside the workshop was overwritten");
    assert.equal(res.status, 200);
    assert.deepEqual(stashEntries(workshopDir), ["alpha"]);
    const refreshed = await action("refresh");
    assert.deepEqual(Array.from(refreshed.stashed, (e) => e.name), ["alpha"]);
});

test("expiry rewrite in readStash does not read or write through a symlink", async (t) => {
    const { home, workshopDir, action } = await loadDashboard(t);
    const expired = JSON.stringify([
        { name: "leaked", stashedAt: new Date(Date.now() - 60_000).toISOString() },
        { name: "old", stashedAt: "2000-01-01T00:00:00.000Z" },
    ]);
    const victim = plantStashSymlink(t, home, workshopDir, expired);
    if (!victim) return;

    const result = await action("refresh");

    assert.equal(readFileSync(victim, "utf8"), expired, "file outside the workshop was rewritten");
    assert.deepEqual(Array.from(result.stashed), [], "contents of the link target were read as stash entries");
});

test("stash replaces a hard-linked .desk-stash.json instead of writing into the shared inode", async (t) => {
    const { home, workshopDir, action } = await loadDashboard(t);
    const victim = join(home, ".profile");
    writeFileSync(victim, OUTSIDE_BODY);
    try {
        linkSync(victim, join(workshopDir, STASH_FILE));
    } catch (error) {
        t.skip(`hard link unavailable: ${error.code}`);
        return;
    }

    await action("stash", { deskName: "alpha" });

    assert.equal(readFileSync(victim, "utf8"), OUTSIDE_BODY, "shared inode was overwritten");
    assert.deepEqual(stashEntries(workshopDir), ["alpha"]);
});

test("stash and restore round-trip through a regular stash file", async (t) => {
    const { workshopDir, action } = await loadDashboard(t);

    await action("stash", { deskName: "alpha" });
    await action("stash", { deskName: "beta" });
    assert.deepEqual(stashEntries(workshopDir), ["alpha", "beta"]);
    await action("restore", { deskName: "alpha" });
    assert.deepEqual(stashEntries(workshopDir), ["beta"]);
    assert.deepEqual(Array.from((await action("refresh")).stashed, (e) => e.name), ["beta"]);
    noTempFilesLeft(workshopDir);
});
