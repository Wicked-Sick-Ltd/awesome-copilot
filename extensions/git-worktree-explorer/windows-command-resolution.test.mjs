import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
    gatherCommitDetails,
    gatherCommits,
    gatherGraphCommits,
    gatherRepository,
    runCommand,
} from "./git-data.mjs";
import { refreshServer, startServer, stopServer } from "./server.mjs";

// Models libuv 1.51.0 search_path (Node v22.23.4 deps/uv/src/win/process.c).
// Bare names are looked up in the child cwd before PATH when
// NeedCurrentDirectoryForExePathW(L"") is true, trying .com and then .exe.
// An absolute path is used as given, so a later fix has to pass that path
// into execFile; resolving it earlier and spawning the bare name still hits cwd.

function hasExtension(name) {
    const dot = name.indexOf(".");
    return dot !== -1 && dot < name.length - 1;
}

function appendExtension(name, extension) {
    return name.endsWith(".") ? `${name}${extension}` : `${name}.${extension}`;
}

function splitFile(file) {
    let index = file.length;
    while (index > 0 && file[index - 1] !== "\\" && file[index - 1] !== "/" && file[index - 1] !== ":") {
        index -= 1;
    }
    return {
        directory: file.slice(0, index),
        name: file.slice(index),
        hasDirectory: index > 0,
    };
}

function envHas(env, name) {
    const target = name.toLowerCase();
    return Object.keys(env).some((key) => key.toLowerCase() === target);
}

function needCurrentDirectoryForExePath(exeName, parentEnv) {
    if (String(exeName).includes("\\")) return true;
    return !envHas(parentEnv, "NoDefaultCurrentDirectoryInExePath");
}

function findFile(candidate) {
    const directory = path.dirname(candidate);
    const base = path.basename(candidate);
    let entries;
    try {
        entries = readdirSync(directory);
    } catch {
        return null;
    }
    const match = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
    if (!match) return null;
    const full = path.join(directory, match);
    try {
        if (!statSync(full).isFile()) return null;
    } catch {
        return null;
    }
    return full;
}

function walkExtensions(directory, name) {
    const candidates = [];
    if (hasExtension(name)) candidates.push(name);
    candidates.push(appendExtension(name, "com"), appendExtension(name, "exe"));
    for (const candidate of candidates) {
        const found = findFile(path.join(directory, candidate));
        if (found) return found;
    }
    return null;
}

function splitWindowsPath(pathEnv) {
    const entries = [];
    let cursor = 0;
    const value = String(pathEnv ?? "");
    while (cursor <= value.length) {
        if (cursor === value.length || value[cursor] === ";") {
            cursor += 1;
            continue;
        }
        const start = cursor;
        let end;
        if (value[start] === "\"" || value[start] === "'") {
            const quote = value[start];
            const quoteEnd = value.indexOf(quote, start + 1);
            end = quoteEnd === -1 ? value.length : quoteEnd;
            cursor = end + 1;
            const separator = value.indexOf(";", cursor);
            cursor = separator === -1 ? value.length : separator;
            let slice = value.slice(start, end + (quoteEnd === -1 ? 0 : 1));
            if ((slice.startsWith("\"") && slice.endsWith("\"")) || (slice.startsWith("'") && slice.endsWith("'"))) {
                slice = slice.slice(1, -1);
            }
            if (slice) entries.push(slice);
            continue;
        }
        end = value.indexOf(";", start);
        if (end === -1) end = value.length;
        const slice = value.slice(start, end);
        if (slice) entries.push(slice);
        cursor = end;
    }
    return entries;
}

function directoryFromPathEntry(entry, cwd) {
    if (path.win32.isAbsolute(entry) || path.posix.isAbsolute(entry)) return entry;
    return path.resolve(cwd, entry);
}

export function resolveWindowsExecutable(file, cwd, options = {}) {
    const parentEnv = options.parentEnv ?? {};
    const pathEnv = options.pathEnv ?? "";
    if (file.length === 0 || file === ".") return null;
    const parts = splitFile(file);
    if (!parts.name) return null;
    if (!parts.hasDirectory) {
        if (needCurrentDirectoryForExePath("", parentEnv)) {
            const found = walkExtensions(path.resolve(cwd), parts.name);
            if (found) return found;
        }
        for (const entry of splitWindowsPath(pathEnv)) {
            const found = walkExtensions(directoryFromPathEntry(entry, cwd), parts.name);
            if (found) return found;
        }
        return null;
    }
    const directory = path.resolve(cwd, parts.directory);
    const found = walkExtensions(directory, parts.name);
    if (found) return found;
    const exact = path.resolve(cwd, file);
    if ((path.isAbsolute(file) || path.win32.isAbsolute(file)) && findFile(exact)) return exact;
    return null;
}

function isInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function callsFor(root) {
    const calls = globalThis.__gweExecFileCalls;
    assert.ok(Array.isArray(calls), "execFile recorder is not installed; run with windows-command-resolution-preload.mjs");
    return calls.filter((call) => call.cwd && isInside(root, call.cwd));
}

function pathEnvFor(call) {
    const env = call.env ?? process.env;
    const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
    return key ? env[key] : "";
}

function assertSpawnsOutsideRepository(root) {
    const calls = callsFor(root);
    assert.ok(calls.length > 0, `no commands were spawned in ${root}`);
    const planted = [];
    for (const call of calls) {
        const chosen = resolveWindowsExecutable(call.file, path.resolve(call.cwd), {
            parentEnv: process.env,
            pathEnv: pathEnvFor(call),
        });
        const command = `${call.file} ${(call.args || []).join(" ")}`.trim();
        if (!chosen || isInside(root, chosen)) {
            planted.push(`${command} (cwd ${call.cwd}) -> ${chosen}`);
        }
    }
    assert.deepEqual(planted, []);
}

function commandLine(call) {
    const base = path.basename(call.file).toLowerCase().replace(/\.(exe|com)$/i, "");
    return `${base} ${(call.args || []).join(" ")}`;
}

function assertCommandRan(root, pattern) {
    const lines = callsFor(root).map(commandLine);
    assert.ok(lines.some((line) => pattern.test(line)), `missing ${pattern} in:\n${lines.join("\n")}`);
}

const realGit = "/usr/bin/git";

function git(cwd, args) {
    return execFileSync(realGit, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function makeRepository() {
    const root = await mkdtemp(path.join(tmpdir(), "git-worktree-explorer-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "dev@example.com"]);
    git(root, ["config", "user.name", "Dev"]);
    await writeFile(path.join(root, "README"), "repository\n");
    git(root, ["add", "README"]);
    git(root, ["commit", "-m", "init"]);
    git(root, ["remote", "add", "origin", "https://github.com/example/example.git"]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    return root;
}

async function plant(root, name) {
    await writeFile(path.join(root, name), "planted\n");
}

const ghConfigDir = await mkdtemp(path.join(tmpdir(), "gh-config-"));
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_ENTERPRISE_TOKEN;
delete process.env.GITHUB_ENTERPRISE_TOKEN;
process.env.GH_CONFIG_DIR = ghConfigDir;

test("windows bare-name search runs a planted git.exe before PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    const pathDir = await mkdtemp(path.join(tmpdir(), "resolver-path-"));
    try {
        await plant(root, "git.exe");
        await plant(pathDir, "git.exe");
        const chosen = resolveWindowsExecutable("git", root, {
            parentEnv: {},
            pathEnv: pathDir,
        });
        assert.equal(chosen, path.join(root, "git.exe"));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(pathDir, { recursive: true, force: true });
    }
});

test("windows bare-name search tries git.com before git.exe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    try {
        await plant(root, "git.com");
        await plant(root, "git.exe");
        const chosen = resolveWindowsExecutable("git", root, { parentEnv: {}, pathEnv: "" });
        assert.equal(chosen, path.join(root, "git.com"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a directory named git.exe is not selected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    const pathDir = await mkdtemp(path.join(tmpdir(), "resolver-path-"));
    try {
        await mkdir(path.join(root, "git.exe"));
        await plant(pathDir, "git.exe");
        const chosen = resolveWindowsExecutable("git", root, { parentEnv: {}, pathEnv: pathDir });
        assert.equal(chosen, path.join(pathDir, "git.exe"));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(pathDir, { recursive: true, force: true });
    }
});

test("NoDefaultCurrentDirectoryInExePath skips the working directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    const pathDir = await mkdtemp(path.join(tmpdir(), "resolver-path-"));
    try {
        await plant(root, "git.exe");
        await plant(pathDir, "git.exe");
        const chosen = resolveWindowsExecutable("git", root, {
            parentEnv: { NoDefaultCurrentDirectoryInExePath: "" },
            pathEnv: pathDir,
        });
        assert.equal(chosen, path.join(pathDir, "git.exe"));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(pathDir, { recursive: true, force: true });
    }
});

test("an absolute path is not replaced by a planted executable in the working directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    const outside = await mkdtemp(path.join(tmpdir(), "resolver-outside-"));
    try {
        await plant(root, "git.exe");
        const outsideGit = path.join(outside, "git");
        await writeFile(outsideGit, "outside\n");
        const chosen = resolveWindowsExecutable(outsideGit, root, { parentEnv: {}, pathEnv: "" });
        assert.equal(chosen, outsideGit);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test("a relative path is joined with the working directory before it is used", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    try {
        await mkdir(path.join(root, "tools"));
        await plant(path.join(root, "tools"), "git.exe");
        const chosen = resolveWindowsExecutable(path.join("tools", "git"), root, { parentEnv: {}, pathEnv: "" });
        assert.equal(chosen, path.join(root, "tools", "git.exe"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("planting git.exe between a lookup and the spawn still selects it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "resolver-"));
    const pathDir = await mkdtemp(path.join(tmpdir(), "resolver-path-"));
    try {
        await plant(pathDir, "git.exe");
        const before = resolveWindowsExecutable("git", root, { parentEnv: {}, pathEnv: pathDir });
        assert.equal(before, path.join(pathDir, "git.exe"));
        await plant(root, "git.exe");
        const atSpawn = resolveWindowsExecutable("git", root, { parentEnv: {}, pathEnv: pathDir });
        assert.equal(atSpawn, path.join(root, "git.exe"));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(pathDir, { recursive: true, force: true });
    }
});

test("opening the canvas gathers git and gh from the repository working directory", async () => {
    const root = await makeRepository();
    const nested = path.join(root, "nested");
    try {
        await plant(root, "git.exe");
        await plant(root, "gh.exe");
        await mkdir(nested);
        await plant(nested, "git.exe");
        const snapshot = await gatherRepository(root);
        assert.equal(path.resolve(snapshot.repository.root), path.resolve(root));
        assert.equal(snapshot.repository.remote.github, true);
        const nestedSnapshot = await gatherRepository(nested);
        assert.equal(path.resolve(nestedSnapshot.repository.root), path.resolve(root));
        const nestedCalls = callsFor(root).filter((call) => path.resolve(call.cwd) === path.resolve(nested));
        assert.ok(nestedCalls.some((call) => call.args[0] === "rev-parse"));
        for (const pattern of [
            /^git rev-parse --show-toplevel$/,
            /^git rev-parse --git-common-dir$/,
            /^git rev-parse --verify HEAD$/,
            /^git remote get-url origin$/,
            /^git symbolic-ref --quiet refs\/remotes\/origin\/HEAD$/,
            /^git status --porcelain=v1 --branch --untracked-files=normal$/,
            /^git worktree list --porcelain$/,
            /^git for-each-ref .*refs\/heads refs\/remotes$/,
            /^git for-each-ref .*ahead-behind:/,
            /^git rev-list --left-right --count /,
            /^gh pr list --repo example\/example --state all --limit 100 --json /,
        ]) {
            assertCommandRan(root, pattern);
        }
        assertSpawnsOutsideRepository(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("canvas startup and refresh gather through the same repository commands", async () => {
    const root = await makeRepository();
    const instanceId = `explorer-${path.basename(root)}`;
    try {
        await plant(root, "git.exe");
        await plant(root, "gh.exe");
        const entry = await startServer(instanceId, {
            cwd: root,
            sendPrompt: async () => {},
        });
        assert.equal(path.resolve(entry.snapshot.repository.root), path.resolve(root));
        await refreshServer(instanceId);
        assertCommandRan(root, /^git rev-parse --show-toplevel$/);
        assertCommandRan(root, /^gh pr list /);
        assertCommandRan(root, /^git rev-list --left-right --count /);
        assertSpawnsOutsideRepository(root);
    } finally {
        await stopServer(instanceId);
        await rm(root, { recursive: true, force: true });
    }
});

test("commit history, graph, and detail queries spawn git in the repository", async () => {
    const root = await makeRepository();
    try {
        await plant(root, "git.exe");
        const sha = git(root, ["rev-parse", "HEAD"]).trim();
        await gatherCommits(root, "HEAD");
        await gatherGraphCommits(root, ["refs/heads/main", sha]);
        const details = await gatherCommitDetails(root, sha, {
            github: true,
            webUrl: "https://github.com/example/example",
        });
        assert.equal(details.sha, sha);
        assertCommandRan(root, /^git log /);
        assertCommandRan(root, /^git log --topo-order --date-order /);
        assertCommandRan(root, /^git show --no-patch /);
        assertCommandRan(root, /^git diff-tree --root --no-commit-id --name-status -r -M /);
        assertSpawnsOutsideRepository(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a planted git.com is selected for a bare git command", async () => {
    const root = await makeRepository();
    try {
        await plant(root, "git.com");
        await runCommand("git", ["rev-parse", "--show-toplevel"], root);
        const chosen = resolveWindowsExecutable("git", root, {
            parentEnv: process.env,
            pathEnv: process.env.PATH ?? "",
        });
        assert.equal(chosen, path.join(root, "git.com"));
        assertSpawnsOutsideRepository(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
