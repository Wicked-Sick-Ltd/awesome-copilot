import test from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import * as url from "node:url";
import vm from "node:vm";

// Run with: node --experimental-vm-modules --test extensions/site-studio/git-branch.test.mjs

const EXTENSION_URL = new URL("./extension.mjs", import.meta.url);
const BUILTINS = new Map([
    ["node:child_process", childProcess],
    ["node:fs", fs],
    ["node:fs/promises", fsPromises],
    ["node:http", http],
    ["node:path", path],
    ["node:url", url],
]);
const LAUNCHERS = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"];

function isInside(child, parent) {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function makeWorkspace(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "site-studio-git-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "studio-branch", workspace);
    writeFileSync(join(workspace, "README.md"), "site\n");
    git("-C", workspace, "add", "README.md");
    git("-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init");
    const marker = join(root, "planted-git-ran");
    return { root, workspace, marker };
}

function plantPosixGit(file, marker) {
    writeFileSync(file, `#!/bin/sh\necho ran > '${marker}'\necho planted-branch\n`, { mode: 0o755 });
}

function withEnv(t, overrides) {
    const saved = {};
    for (const [key, value] of Object.entries(overrides)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

async function openSiteStudio(t, workspace) {
    const launches = [];
    const writes = [];
    let canvas;
    const context = vm.createContext({
        process, Buffer, URL, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    });
    const module = new vm.SourceTextModule(readFileSync(EXTENSION_URL, "utf8"), {
        context,
        identifier: EXTENSION_URL.href,
        initializeImportMeta(meta) {
            meta.url = EXTENSION_URL.href;
        },
    });
    await module.link((specifier) => {
        let exports;
        if (specifier === "@github/copilot-sdk/extension") {
            exports = {
                createCanvas: (definition) => definition,
                joinSession: async (options) => {
                    [canvas] = options.canvases;
                    return { workspacePath: workspace };
                },
                CanvasError: class CanvasError extends Error {},
            };
        } else if (specifier === "node:fs/promises") {
            exports = {
                ...fsPromises,
                readFile: async () => {
                    throw Object.assign(new Error("no state"), { code: "ENOENT" });
                },
                mkdir: async () => {},
                writeFile: async (_file, data) => {
                    writes.push(String(data));
                },
            };
        } else if (specifier === "node:child_process") {
            exports = { ...childProcess };
            for (const name of LAUNCHERS) {
                exports[name] = (...args) => {
                    launches.push({ name, args });
                    return childProcess[name](...args);
                };
            }
        } else if (BUILTINS.has(specifier)) {
            exports = BUILTINS.get(specifier);
        } else {
            throw new Error(`unexpected import ${specifier}`);
        }
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    const instanceId = "git-branch-test";
    t.after(() => canvas.onClose({ instanceId }));
    await canvas.open({ instanceId, session: { workingDirectory: workspace } });
    const branch = JSON.parse(writes.at(-1)).branch;
    return { branch, launches };
}

const posixOnly = { skip: process.platform === "win32" && "POSIX shell lookup" };

for (const [label, prefix] of [["an empty", ""], ["a relative", "."]]) {
    test(`opening the canvas does not run a git planted in the workspace and reached via ${label} PATH entry`, posixOnly, async (t) => {
        const { workspace, marker } = makeWorkspace(t);
        plantPosixGit(join(workspace, "git"), marker);
        withEnv(t, { PATH: `${prefix}${delimiter}${process.env.PATH}`, COPILOT_WORKSPACE_BRANCH: undefined });

        const { branch } = await openSiteStudio(t, workspace);

        assert.equal(existsSync(marker), false, "the git program planted in the workspace was executed");
        assert.equal(branch, "studio-branch");
    });
}

for (const [label, toolsPath] of [
    ["", (workspace) => join(workspace, "tools")],
    [" written with ..", (workspace) => `${workspace}${sep}tools${sep}..${sep}..${sep}workspace${sep}tools`],
]) {
    test(`ignores a git found in a PATH directory inside the workspace${label}`, posixOnly, async (t) => {
        const { workspace, marker } = makeWorkspace(t);
        mkdirSync(join(workspace, "tools"));
        plantPosixGit(join(workspace, "tools", "git"), marker);
        withEnv(t, { PATH: `${toolsPath(workspace)}${delimiter}${process.env.PATH}`, COPILOT_WORKSPACE_BRANCH: undefined });

        const { branch } = await openSiteStudio(t, workspace);

        assert.equal(existsSync(marker), false, "the git program planted in the workspace was executed");
        assert.equal(branch, "studio-branch");
    });
}

test("ignores a PATH git that is a symlink into the workspace", posixOnly, async (t) => {
    const { root, workspace, marker } = makeWorkspace(t);
    plantPosixGit(join(workspace, "evil-git"), marker);
    const linkBin = join(root, "link-bin");
    mkdirSync(linkBin);
    symlinkSync(join(workspace, "evil-git"), join(linkBin, "git"));
    withEnv(t, { PATH: `${linkBin}${delimiter}${process.env.PATH}`, COPILOT_WORKSPACE_BRANCH: undefined });

    const { branch } = await openSiteStudio(t, workspace);

    assert.equal(existsSync(marker), false, "the git program planted in the workspace was executed");
    assert.equal(branch, "studio-branch");
});

test("launches git by absolute path, without a shell, outside the workspace, with the repository as -C", async (t) => {
    const { workspace } = makeWorkspace(t);
    withEnv(t, { COPILOT_WORKSPACE_BRANCH: undefined });

    const { branch, launches } = await openSiteStudio(t, workspace);

    assert.equal(branch, "studio-branch");
    assert.ok(launches.length > 0, "expected git to be launched");
    for (const { name, args } of launches) {
        assert.ok(!["exec", "execSync"].includes(name), `${name} runs its command through a shell`);
        const [file, argv, options = {}] = args;
        assert.ok(isAbsolute(file), `git must be launched by absolute path, got ${file}`);
        assert.ok(!isInside(file, workspace), `git must not resolve inside the workspace, got ${file}`);
        assert.ok(!options.shell, "git must not be launched through a shell");
        assert.ok(options.cwd && !isInside(options.cwd, workspace), "the child must not start in the workspace");
        assert.equal(argv[0], "-C");
    }
    assert.ok(launches.some(({ args }) => args[1][1] === workspace), "the workspace must be passed with -C");
});

test("opening the canvas on Windows does not run git.cmd, git.bat, or git.exe planted in the workspace", {
    skip: process.platform !== "win32" && "Windows cmd.exe lookup",
}, async (t) => {
    const { workspace, marker } = makeWorkspace(t);
    const script = `@echo ran> "${marker}"\r\n@echo planted-branch\r\n`;
    writeFileSync(join(workspace, "git.cmd"), script);
    writeFileSync(join(workspace, "git.bat"), script);
    withEnv(t, { COPILOT_WORKSPACE_BRANCH: undefined });

    const { branch, launches } = await openSiteStudio(t, workspace);

    assert.equal(existsSync(marker), false, "the git program planted in the workspace was executed");
    assert.equal(branch, "studio-branch");
    for (const { args } of launches) {
        assert.match(args[0], /\.exe$/i);
        assert.ok(!isInside(args[0].toLowerCase(), workspace.toLowerCase()));
    }
});
