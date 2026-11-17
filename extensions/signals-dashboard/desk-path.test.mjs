import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

// A workshop checkout is untrusted content: git recreates committed symlinks, so
// desks/<name> or the desks/ folder itself can point anywhere on disk. These
// tests drive the real extension handlers against such a checkout.

const symlinkSkip = process.platform === "win32" ? "symlink creation needs privileges on Windows" : false;

async function loadDashboard(t) {
    const root = mkdtempSync(join(tmpdir(), "workshop-desk-path-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    const workshopDir = join(root, "workshop");
    const outside = join(root, "outside");
    mkdirSync(bin);
    mkdirSync(join(workshopDir, "desks", "probe"), { recursive: true });
    mkdirSync(join(outside, "secret-desk"), { recursive: true });
    writeFileSync(join(outside, "credentials.txt"), "placeholder\n");
    for (const name of ["copilot", "sh", "xterm"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const imports = new Map();
    for (const specifier of [
        "node:http", "node:fs", "node:fs/promises", "node:path", "node:child_process", "node:crypto",
        "./launch-profile.mjs", "./local-delegation.mjs",
    ]) {
        imports.set(specifier, await import(specifier.startsWith(".")
            ? new URL(specifier, import.meta.url).href : specifier));
    }
    const spawned = [];
    let canvas;
    const context = vm.createContext({
        process: {
            ...process,
            platform: "linux",
            env: { ...process.env, PATH: bin, WORKSHOP_DESK_AGENT: "copilot" },
        },
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
            if (specifier === "node:child_process") {
                exports = {
                    ...exports,
                    spawn: (command, args, options) => {
                        spawned.push({ command, args, options });
                        const child = new EventEmitter();
                        child.unref = () => {};
                        queueMicrotask(() => child.emit("spawn"));
                        return child;
                    },
                };
            } else if (specifier === "node:fs") {
                const fs = exports;
                exports = {
                    ...fs,
                    statSync: (file) => file === "/bin/sh" ? { isFile: () => true } : fs.statSync(file),
                    accessSync: (file, mode) => { if (file !== "/bin/sh") fs.accessSync(file, mode); },
                };
            } else if (specifier === "./local-delegation.mjs") {
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
    const instanceId = "desk-path-test";
    t.after(() => canvas.onClose({ instanceId }));
    const action = (name, input) => canvas.actions.find((a) => a.name === name)
        .handler({ instanceId, input });
    const opened = await canvas.open({ instanceId, input: { workshopDir } });
    const httpOpen = async (deskName) => {
        const page = await (await fetch(opened.url)).text();
        const token = JSON.parse(page.match(/const WORKSHOP_TOKEN = (".*?");/)[1]);
        const res = await fetch(new URL(`/api/open/${encodeURIComponent(deskName)}?profile=connected`, opened.url),
            { method: "POST", headers: { "x-workshop-token": token } });
        return { status: res.status, body: await res.json() };
    };
    return { root, workshopDir, outside, spawned, action, httpOpen };
}

function assertNoOutsidePath(result, outside) {
    assert.ok(!JSON.stringify(result).includes(outside),
        `result must not expose a path outside the workshop: ${JSON.stringify(result)}`);
    assert.equal(result.deskPath, undefined);
}

test("get_desk_path still resolves a real desk inside the workshop", async (t) => {
    const d = await loadDashboard(t);
    const result = await d.action("get_desk_path", { deskName: "probe" });
    assert.equal(result.ok, true);
    assert.equal(result.deskPath, realpathSync(join(d.workshopDir, "desks", "probe")));
});

test("get_desk_path refuses a desk symlink that escapes the workshop", { skip: symlinkSkip }, async (t) => {
    const d = await loadDashboard(t);
    symlinkSync(d.outside, join(d.workshopDir, "desks", "notes"), "dir");
    const result = await d.action("get_desk_path", { deskName: "notes" });
    assert.ok(result.error, `expected an error, got ${JSON.stringify(result)}`);
    assertNoOutsidePath(result, d.outside);
});

test("get_desk_path refuses a symlinked classroom folder that escapes the workshop", { skip: symlinkSkip }, async (t) => {
    const d = await loadDashboard(t);
    symlinkSync(d.outside, join(d.workshopDir, "classroom"), "dir");
    const result = await d.action("get_desk_path", { deskName: "secret-desk" });
    assert.ok(result.error, `expected an error, got ${JSON.stringify(result)}`);
    assertNoOutsidePath(result, d.outside);
});

test("get_desk_path refuses a desk symlink even when it points inside the workshop", { skip: symlinkSkip }, async (t) => {
    const d = await loadDashboard(t);
    symlinkSync(join(d.workshopDir, "desks", "probe"), join(d.workshopDir, "desks", "alias"), "dir");
    const result = await d.action("get_desk_path", { deskName: "alias" });
    assert.ok(result.error, `expected an error, got ${JSON.stringify(result)}`);
    assert.equal(result.deskPath, undefined);
});

test("open_desk refuses an escaping desk symlink and does not hand back its path", { skip: symlinkSkip }, async (t) => {
    const d = await loadDashboard(t);
    symlinkSync(d.outside, join(d.workshopDir, "desks", "notes"), "dir");
    const result = await d.action("open_desk", { deskName: "notes", profile: "connected" });
    assert.ok(result.error, `expected an error, got ${JSON.stringify(result)}`);
    assertNoOutsidePath(result, d.outside);
    assert.equal(d.spawned.length, 0);
});

test("open_desk refuses a desk under a symlinked desks folder", { skip: symlinkSkip }, async (t) => {
    const d = await loadDashboard(t);
    rmSync(join(d.workshopDir, "desks"), { recursive: true });
    symlinkSync(d.outside, join(d.workshopDir, "desks"), "dir");
    const result = await d.action("open_desk", { deskName: "secret-desk", profile: "connected" });
    assert.ok(result.error, `expected an error, got ${JSON.stringify(result)}`);
    assertNoOutsidePath(result, d.outside);
    assert.equal(d.spawned.length, 0);
});

test("open_desk launches a real desk from its resolved path", async (t) => {
    const d = await loadDashboard(t);
    const result = await d.action("open_desk", { deskName: "probe", profile: "connected" });
    const real = realpathSync(join(d.workshopDir, "desks", "probe"));
    assert.equal(result.ok, true);
    assert.equal(result.launched, true);
    assert.equal(result.deskPath, real);
    assert.equal(d.spawned.at(-1).options.cwd, real);
});

test("loopback open route refuses an escaping desk symlink without exposing its path", { skip: symlinkSkip }, async (t) => {
    const d = await loadDashboard(t);
    symlinkSync(d.outside, join(d.workshopDir, "desks", "notes"), "dir");
    const { status, body } = await d.httpOpen("notes");
    assert.notEqual(status, 200);
    assert.notEqual(body.ok, true);
    assertNoOutsidePath(body, d.outside);
    assert.equal(d.spawned.length, 0);
});

test("loopback open route still opens a real desk", async (t) => {
    const d = await loadDashboard(t);
    const { status, body } = await d.httpOpen("probe");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.deskPath, realpathSync(join(d.workshopDir, "desks", "probe")));
});
