// Spec for the Where Was I Windows executable-search bug.
//
// These tests fail while gatherGitContext / getFileDiff / gatherContext still
// pass a bare "git" or "gh" to execFile with the opened worktree as cwd. They
// pass once every such command is an absolute path outside that worktree.
//
// The Windows decision is libuv 1.51.0 (Node 22.23.4) deps/uv/src/win/process.c
// search_path, invoked by uv_spawn with the child cwd. Node does not resolve
// the name before that call. This file ports that search, including every
// branch that changes which file is chosen, and runs the file it selects.

import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const realExecFile = childProcess.execFile;
const realExecFileSync = childProcess.execFileSync;
const realSpawnSync = childProcess.spawnSync;

const NO_DEFAULT_CWD_ENV = "NoDefaultCurrentDirectoryInExePath";
const CANARY = "placeholder";

const calls = [];
let armedWorktree = null;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
            return {
                url: new URL("./windows-exe-search-sdk-mock.mjs", import.meta.url).href,
                shortCircuit: true,
            };
        }
        return nextResolve(specifier, context);
    },
});

// ChildProcess.prototype.spawn copies options.file and options.cwd straight
// into uv_spawn (Node 22.23.4 src/process_wrap.cc). execFile does not put a
// directory on the command (lib/child_process.js normalizeSpawnArguments).
childProcess.execFile = function recordExecFile(file, args, options, callback) {
    const cwd = options && typeof options.cwd === "string" ? options.cwd : process.cwd();
    const selected = resolveWindowsExecutable(String(file), cwd, process.env);
    calls.push({
        file: String(file),
        args: Array.isArray(args) ? args.map(String) : [],
        cwd,
        selected,
    });
    if (armedWorktree && selected && isInside(armedWorktree, selected)) {
        // The planted file is the application_path libuv would pass to
        // CreateProcessW. Launch it with the parent environment, which is what
        // execFile copies when options.env is omitted (child_process.js).
        realSpawnSync(selected, Array.isArray(args) ? args.map(String) : [], {
            cwd,
            env: { ...process.env },
            encoding: "utf8",
        });
    }
    return realExecFile(file, args, options, callback);
};

function isInside(root, candidate) {
    const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
    return relativePath === ""
        || (relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relativePath));
}

function isAbsoluteCommand(file) {
    return path.posix.isAbsolute(file) || path.win32.isAbsolute(file);
}

// ReactOS kernel32 path.c NeedCurrentDirectoryForExePathW (commit
// 2def708122ac27e642f77f656cc3eb2a200aa640, lines 1015-1019) and
// BasepIsCurDirAllowedForPlainExeNames (lines 839-848). Libuv calls the API
// with an empty name (process.c line 381), so only the environment variable's
// presence matters. A zero-length query returns STATUS_BUFFER_TOO_SMALL when
// the variable exists, and the function then returns FALSE.
function needCurrentDirectoryForExePathW(exeName, env) {
    if (String(exeName).includes("\\")) return true;
    const present = Object.keys(env).some((key) => key.toLowerCase() === NO_DEFAULT_CWD_ENV.toLowerCase());
    return !present;
}

function hostSep(value) {
    return value.includes("\\") && !value.includes("/") ? "\\" : "/";
}

function splitFile(file) {
    let nameStart = file.length;
    while (nameStart > 0) {
        const character = file[nameStart - 1];
        if (character === "\\" || character === "/" || character === ":") break;
        nameStart -= 1;
    }
    return {
        hasDir: nameStart !== 0,
        dir: file.slice(0, nameStart),
        name: file.slice(nameStart),
    };
}

function nameHasExtension(name) {
    const dot = name.indexOf(".");
    return dot !== -1 && dot < name.length - 1;
}

// search_path_join_test, process.c lines 151-239. Slashes are written with the
// host separator so GetFileAttributesW's existence check can see a planted
// file on the machine running the test. The drive-letter and UNC branches
// follow the C conditions.
function buildCandidate(dir, name, ext, cwd) {
    let directory = dir;
    let cwdLength = cwd.length;
    if (directory.length > 2
        && (directory[0] === "\\" || directory[0] === "/")
        && (directory[1] === "\\" || directory[1] === "/")) {
        cwdLength = 0;
    } else if (directory.length >= 1 && (directory[0] === "/" || directory[0] === "\\")) {
        cwdLength = 2;
    } else if (directory.length >= 2 && directory[1] === ":"
        && (directory.length < 3 || (directory[2] !== "/" && directory[2] !== "\\"))) {
        if (cwd.length < 2 || cwd.slice(0, 2).toLowerCase() !== directory.slice(0, 2).toLowerCase()) {
            cwdLength = 0;
        } else {
            directory = directory.slice(2);
        }
    } else if (directory.length > 2 && directory[1] === ":") {
        cwdLength = 0;
    }

    const separator = hostSep(cwdLength > 0 ? cwd : directory);
    let result = cwd.slice(0, cwdLength);
    if (cwdLength > 0 && !"\\/:".includes(result[result.length - 1])) result += separator;
    result += directory;
    if (directory.length > 0 && !"\\/:".includes(result[result.length - 1])) result += separator;
    result += name;
    if (ext) {
        if (!name.endsWith(".")) result += ".";
        result += ext;
    }
    return result;
}

function fileExistsAndIsNotDirectory(candidate) {
    try {
        return !lstatSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

// path_search_walk_ext, process.c lines 246-284. Extensions are appended, and
// .com is tried before .exe. A name with no extension is not tried as itself.
function walkExtensions(dir, name, cwd, allowExactName) {
    if (allowExactName) {
        const exact = buildCandidate(dir, name, "", cwd);
        if (fileExistsAndIsNotDirectory(exact)) return exact;
    }
    const com = buildCandidate(dir, name, "com", cwd);
    if (fileExistsAndIsNotDirectory(com)) return com;
    const exe = buildCandidate(dir, name, "exe", cwd);
    if (fileExistsAndIsNotDirectory(exe)) return exe;
    return null;
}

// PATH walk, process.c lines 389-437. Entries are separated by ';'. Quoted
// entries keep their quotes out of the directory. Relative entries stay
// relative to cwd because search_path_join_test prepends cwd for them.
function walkPath(pathValue, name, cwd, allowExactName) {
    if (!pathValue) return null;
    let cursor = 0;
    while (cursor <= pathValue.length) {
        if (cursor === pathValue.length) break;
        if (cursor !== 0 || pathValue[0] === ";") cursor += 1;
        if (cursor > pathValue.length) break;
        const start = cursor;
        if (pathValue[start] === "\"" || pathValue[start] === "'") {
            const closing = pathValue.indexOf(pathValue[start], start + 1);
            cursor = closing === -1 ? pathValue.length : closing;
        }
        const separator = pathValue.indexOf(";", cursor);
        const end = separator === -1 ? pathValue.length : separator;
        cursor = end;
        if (end === start) continue;
        let entry = pathValue.slice(start, end);
        if ((entry.startsWith("\"") || entry.startsWith("'")) && entry.length > 1) {
            const quote = entry[0];
            entry = entry.slice(1);
            if (entry.endsWith(quote)) entry = entry.slice(0, -1);
        }
        const found = walkExtensions(entry, name, cwd, allowExactName);
        if (found) return found;
        if (end === pathValue.length) break;
    }
    return null;
}

// search_path, process.c lines 332-441. Node's process_wrap.cc does not set
// UV_PROCESS_WINDOWS_FILE_PATH_EXACT_NAME, so an extensionless name is not
// looked up without .com/.exe unless it already contains a directory.
export function resolveWindowsExecutable(file, cwd, env, pathValue = env.PATH || env.Path || "") {
    if (file.length === 0 || file === ".") return null;
    const parts = splitFile(file);
    const allowExact = nameHasExtension(parts.name);
    if (parts.hasDir) {
        return walkExtensions(parts.dir, parts.name, cwd, allowExact);
    }
    // process.c line 381. The empty string has no backslash, so a default
    // process (variable unset) searches the spawn cwd before PATH.
    if (needCurrentDirectoryForExePathW("", env)) {
        const found = walkExtensions("", parts.name, cwd, allowExact);
        if (found) return found;
    }
    return walkPath(pathValue, parts.name, cwd, allowExact);
}

function writeExecutable(directory, name) {
    const file = path.join(directory, name);
    writeFileSync(
        file,
        "#!/bin/sh\nprintf '%s %s\\n' \"$0\" \"${WHERE_WAS_I_CANARY-}\" >> \"$WHERE_WAS_I_MARKER\"\n",
    );
    chmodSync(file, 0o755);
    return file;
}

function git(cwd, args) {
    return realExecFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerText(marker) {
    return existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
}

function violations(worktree, marker) {
    const problems = [];
    const ran = markerText(marker);
    if (ran) {
        problems.push(`A planted worktree executable ran and read WHERE_WAS_I_CANARY:\n${ran}`);
    }
    for (const call of calls) {
        const label = `${JSON.stringify(call.file)} [${call.args.join(" ")}] cwd=${call.cwd}`;
        if (!isAbsoluteCommand(call.file)) {
            problems.push(`execFile command is not an absolute path: ${label}`);
        } else if (isInside(worktree, call.file)) {
            problems.push(`execFile command is inside the opened worktree: ${label}`);
        }
        if (call.selected && isInside(worktree, call.selected)) {
            problems.push(`Windows search selects a worktree executable: ${label} -> ${call.selected}`);
        }
    }
    return problems;
}

test("Windows search runs cwd\\git.exe before PATH when the guard variable is unset", () => {
    const root = mkdtempSync(path.join(tmpdir(), "where-was-i-search-"));
    try {
        const worktree = path.join(root, "repo");
        const trusted = path.join(root, "trusted");
        mkdirSync(worktree);
        mkdirSync(trusted);
        writeExecutable(worktree, "git.exe");
        writeExecutable(worktree, "git");
        writeExecutable(trusted, "git.exe");
        writeExecutable(worktree, "git.com");
        const env = {};

        const selected = resolveWindowsExecutable("git", worktree, env, `../trusted`);
        assert.equal(path.basename(selected), "git.com");

        rmSync(path.join(worktree, "git.com"));
        const exe = resolveWindowsExecutable("git", worktree, env, `../trusted`);
        assert.equal(exe, path.join(worktree, "git.exe"));

        const guarded = resolveWindowsExecutable(
            "git",
            worktree,
            { [NO_DEFAULT_CWD_ENV]: "" },
            "../trusted",
        );
        assert.equal(path.resolve(guarded), path.resolve(trusted, "git.exe"));

        const named = resolveWindowsExecutable("git.exe", worktree, env, "");
        assert.equal(named, path.join(worktree, "git.exe"));

        // A command that already contains a directory is not replaced by the
        // cwd copy. On this host the absolute path has no drive letter, so the
        // libuv "leading slash keeps only the cwd drive letter" branch does
        // not reopen the worktree file.
        const absolute = resolveWindowsExecutable(
            path.join(trusted, "git.exe"),
            worktree,
            env,
            "",
        );
        assert.ok(absolute === null || !isInside(worktree, absolute));
        assert.equal(
            buildCandidate("C:\\trusted\\", "git.exe", "", "D:\\repo"),
            "C:\\trusted\\git.exe",
        );

        mkdirSync(path.join(worktree, "gh.exe"));
        assert.equal(resolveWindowsExecutable("gh", worktree, env, ""), null);
        rmSync(path.join(worktree, "gh.exe"), { recursive: true });
        writeExecutable(worktree, "gh.exe");
        assert.equal(resolveWindowsExecutable("gh", worktree, env, ""), path.join(worktree, "gh.exe"));

        const quotedMiss = resolveWindowsExecutable(
            "gh",
            worktree,
            { [NO_DEFAULT_CWD_ENV]: "1" },
            "\"../trusted\"",
        );
        assert.equal(quotedMiss, null);
        writeExecutable(trusted, "gh.exe");
        const quotedFound = resolveWindowsExecutable(
            "gh",
            worktree,
            { [NO_DEFAULT_CWD_ENV]: "1" },
            "\"../trusted\"",
        );
        assert.equal(path.resolve(quotedFound), path.resolve(trusted, "gh.exe"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("opening Where Was I executes a planted git.exe and gh.exe from the worktree", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "where-was-i-canvas-"));
    const workspace = path.join(root, "workspace");
    const worktree = path.join(root, "worktree");
    const marker = path.join(root, "ran.txt");
    mkdirSync(workspace);
    mkdirSync(worktree);
    process.env.WHERE_WAS_I_WORKSPACE = workspace;
    process.env.WHERE_WAS_I_MARKER = marker;
    process.env.WHERE_WAS_I_CANARY = CANARY;
    delete process.env[NO_DEFAULT_CWD_ENV];

    git(worktree, ["init", "-b", "main"]);
    git(worktree, ["config", "user.email", "canvas@example.com"]);
    git(worktree, ["config", "user.name", "Canvas Tester"]);
    writeFileSync(path.join(worktree, "README.md"), "seed\n");
    const plantedGit = writeExecutable(worktree, "git.exe");
    const plantedGh = writeExecutable(worktree, "gh.exe");
    git(worktree, ["add", "README.md", "git.exe", "gh.exe"]);
    git(worktree, ["commit", "-m", "Plant executables"]);
    writeFileSync(path.join(worktree, "README.md"), "changed\n");
    const nested = path.join(worktree, "nested");
    mkdirSync(nested);

    calls.length = 0;
    armedWorktree = worktree;
    t.after(() => {
        armedWorktree = null;
        rmSync(root, { recursive: true, force: true });
    });

    const sdk = await import("./windows-exe-search-sdk-mock.mjs");
    await import("./extension.mjs");
    const { gatherGitContext, getFileDiff } = await import("./git-context.mjs");
    const canvas = sdk.joinedSessionOptions.canvases[0];
    const instanceId = "where-was-i-exe-search";
    t.after(async () => {
        await canvas.onClose({ instanceId });
    });

    const opened = await canvas.open({
        instanceId,
        session: { workingDirectory: worktree },
    });
    const refresh = canvas.actions.find((action) => action.name === "refresh");
    await refresh.handler({
        instanceId,
        session: { workingDirectory: worktree },
    });

    const page = new URL(opened.url);
    const token = page.searchParams.get("k");
    const refreshResponse = await fetch(new URL(`/refresh?k=${token}`, page.origin), { method: "POST" });
    assert.equal(refreshResponse.status, 200);
    const diffResponse = await fetch(
        new URL(`/file-diff?k=${token}&path=README.md`, page.origin),
    );
    assert.equal(diffResponse.status, 200);

    await getFileDiff(worktree, "README.md");
    await gatherGitContext(nested);
    await getFileDiff(nested, "README.md");

    const commandName = (file) => path.win32.basename(file.replaceAll("\\", "/")).toLowerCase();
    assert.ok(
        calls.some((call) => commandName(call.file) === "git" || commandName(call.file) === "git.exe"),
        "the canvas path did not launch git",
    );
    assert.ok(
        calls.some((call) => commandName(call.file) === "gh" || commandName(call.file) === "gh.exe"),
        "the canvas path did not launch gh",
    );
    assert.ok(calls.some((call) => call.args[0] === "pr" && call.args[1] === "list"));
    assert.ok(calls.some((call) => call.args[0] === "issue" && call.args[1] === "list"));
    assert.ok(
        calls.some((call) => call.cwd === worktree || path.resolve(call.cwd) === path.resolve(worktree)),
        "no command used the opened worktree as its working directory",
    );

    const problems = violations(worktree, marker);
    assert.deepEqual(problems, [], problems.join("\n"));
    assert.equal(plantedGit.endsWith(`${path.sep}git.exe`), true);
    assert.equal(plantedGh.endsWith(`${path.sep}gh.exe`), true);
});
