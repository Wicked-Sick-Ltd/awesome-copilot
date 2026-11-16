import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

// Windows (libuv's CreateProcess wrapper and cmd.exe) looks for a bare program
// name in the working directory before PATH, and resolves relative PATH entries
// against it. Every launch must therefore name an absolute program and run from
// a directory other than the caller's working directory.
const PLANTED_PROGRAMS = ["powershell.exe", "cmd.exe", "taskkill.exe", "docker.exe", "uv.exe", "npm.cmd"];

const launches = [];
let heldExecFileReplies;

function fakeExecFile(file, args, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }
    launches.push({ file, args: args ?? [], options: options ?? {} });
    const child = { pid: 4242, killed: false, kill() { this.killed = true; } };
    const reply = () => callback?.(null, "[]", "");
    if (heldExecFileReplies && path.basename(file).toLowerCase() !== "taskkill.exe") {
        heldExecFileReplies.push(reply);
    } else {
        process.nextTick(reply);
    }
    return child;
}
fakeExecFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
    fakeExecFile(file, args, options, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
});

function fakeSpawn(file, args, options) {
    launches.push({ file, args: args ?? [], options: options ?? {} });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let input = "";
    child.stdin.on("data", (chunk) => {
        input += chunk;
        const lines = input.split("\n");
        input = lines.pop();
        for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            child.stdout.write(`${JSON.stringify({ id: request.id, attributes: 0 })}\n`);
        }
    });
    child.stdin.on("finish", () => {
        if (input.trim().startsWith("[")) {
            for (const target of JSON.parse(input)) {
                child.stdout.write(`${JSON.stringify({ path: target, success: true })}\n`);
            }
        }
        child.stdout.end();
        setImmediate(() => {
            child.exitCode = 0;
            child.emit("close", 0);
        });
    });
    return child;
}

const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
let sandbox;
let attackerDirectory;
let toolsDirectory;
let modules;

function isAbsoluteProgram(file) {
    return path.win32.isAbsolute(file) || path.posix.isAbsolute(file);
}

function resolveLikeWindows(file, cwd) {
    if (isAbsoluteProgram(file)) {
        return file;
    }
    if (/[\\/]/.test(file)) {
        return path.resolve(cwd, file);
    }
    const searchDirectories = [cwd, ...String(process.env.PATH).split(path.delimiter).map((entry) => path.resolve(cwd, entry))];
    for (const directory of searchDirectories) {
        const candidate = path.join(directory, file);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return file;
}

function cmdProgram(args) {
    const commandIndex = args.findIndex((arg) => /^\/c$/i.test(arg));
    let commandLine = args.slice(commandIndex + 1).join(" ").trim();
    if (args.some((arg) => /^\/s$/i.test(arg)) && commandLine.startsWith("\"") && commandLine.endsWith("\"")) {
        commandLine = commandLine.slice(1, -1);
    }
    const match = commandLine.match(/^"([^"]+)"|^(\S+)/);
    return match[1] ?? match[2];
}

function assertNoPlantedProgram(launch) {
    const cwd = launch.options.cwd ?? process.cwd();
    const resolved = resolveLikeWindows(launch.file, cwd);
    assert.ok(
        !resolved.startsWith(attackerDirectory),
        `${launch.file} resolved to planted program ${resolved}`,
    );
    if (path.win32.basename(launch.file).toLowerCase() === "cmd.exe") {
        const program = cmdProgram(launch.args);
        const resolvedProgram = resolveLikeWindows(program, cwd);
        assert.ok(!resolvedProgram.startsWith(attackerDirectory), `cmd.exe resolved ${program} to planted program ${resolvedProgram}`);
        assert.ok(isAbsoluteProgram(program), `cmd.exe must be given an absolute program, got ${program}`);
    }
    assert.ok(isAbsoluteProgram(launch.file), `${launch.file} must be launched by absolute path`);
    assert.ok(launch.options.cwd, `${launch.file} must run from a fixed working directory`);
    assert.notEqual(path.resolve(cwd), path.resolve(attackerDirectory), `${launch.file} must not run from the caller's directory`);
}

async function captureLaunches(action) {
    const start = launches.length;
    try {
        await action();
    } catch {
        // Only the launches matter here; the fake processes return placeholder output.
    }
    const captured = launches.slice(start);
    assert.ok(captured.length > 0, "expected the code path to start a process");
    for (const launch of captured) {
        assertNoPlantedProgram(launch);
    }
    return captured;
}

before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "storage-inspector-launch-"));
    attackerDirectory = path.join(sandbox, "opened-repository");
    toolsDirectory = path.join(sandbox, "tools");
    const localAppData = path.join(sandbox, "LocalAppData");
    await mkdir(attackerDirectory, { recursive: true });
    await mkdir(toolsDirectory, { recursive: true });
    await mkdir(path.join(localAppData, "Programs", "Microsoft VS Code Insiders"), { recursive: true });
    await mkdir(path.join(sandbox, "OneDrive"), { recursive: true });
    for (const program of PLANTED_PROGRAMS) {
        await writeFile(path.join(attackerDirectory, program), "planted");
    }
    for (const program of ["docker.exe", "uv.exe", "npm.cmd"]) {
        await writeFile(path.join(toolsDirectory, program), "installed");
    }

    Object.assign(process.env, {
        SystemRoot: "C:\\Windows",
        PATH: [".", "", toolsDirectory, originalEnv.PATH ?? ""].join(path.delimiter),
        LOCALAPPDATA: localAppData,
        USERPROFILE: path.join(sandbox, "Profile"),
        OneDrive: path.join(sandbox, "OneDrive"),
    });
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    childProcess.execFile = fakeExecFile;
    childProcess.spawn = fakeSpawn;
    syncBuiltinESMExports();
    process.chdir(attackerDirectory);

    modules = {
        commands: await import("../src/core/analyzer-commands.mjs"),
        cleanup: await import("../src/core/cleanup.mjs"),
        cloudFiles: await import("../src/core/cloud-files.mjs"),
        docker: await import("../src/analyzers/docker-images.mjs"),
        npm: await import("../src/analyzers/npm-cache.mjs"),
        uv: await import("../src/analyzers/uv-cache.mjs"),
        scout: await import("../src/analyzers/microsoft-scout.mjs"),
        vscode: await import("../src/analyzers/vscode-insiders.mjs"),
    };
});

after(async () => {
    process.chdir(originalCwd);
    childProcess.execFile = originalExecFile;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", originalPlatform);
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key];
        }
    }
    Object.assign(process.env, originalEnv);
    await rm(sandbox, { recursive: true, force: true });
});

const emptyScan = { directories: [], largestFiles: [] };

test("storage scan analyzers do not run programs planted in the working directory", async () => {
    await captureLaunches(() => modules.docker.analyzeDockerImages(emptyScan));
    await captureLaunches(() => modules.uv.analyzeUvCache(emptyScan));
    await captureLaunches(() => modules.npm.analyzeNpmCache(emptyScan));
    await captureLaunches(() => modules.scout.analyzeMicrosoftScout(emptyScan));
    await captureLaunches(() => modules.vscode.analyzeVsCodeInsiders(emptyScan));
});

test("installed CLIs are taken from absolute PATH entries, never relative ones", async () => {
    const [dockerLaunch] = await captureLaunches(() => modules.docker.analyzeDockerImages(emptyScan));
    assert.equal(dockerLaunch.file, path.join(toolsDirectory, "docker.exe"));
    const [npmLaunch] = await captureLaunches(() => modules.npm.analyzeNpmCache(emptyScan));
    assert.equal(cmdProgram(npmLaunch.args), path.join(toolsDirectory, "npm.cmd"));
});

test("known-folder lookup, Recycle Bin and OneDrive helpers do not run a planted PowerShell", async () => {
    await captureLaunches(() => modules.cleanup.createCleanupPreview({
        itemIds: ["item"],
        candidates: [{ id: "item", path: path.join(sandbox, "missing.bin") }],
        approvedRoots: [],
    }));
    await captureLaunches(() => modules.cleanup.executeCleanupPreview({
        preview: {
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            entries: [{ path: path.join(sandbox, "Profile", "cache.bin"), bytes: 1 }],
            approvedRoots: [],
            analyzerProtectedPaths: [],
        },
        confirmed: true,
        knownFolderPaths: [],
        revalidateEntry: async (entry) => entry,
    }));
    const reader = new modules.cloudFiles.CloudFileAttributeReader();
    await captureLaunches(async () => {
        await reader.read(path.join(sandbox, "OneDrive", "file.txt"));
        await reader.close();
    });
});

test("confirmed analyzer commands do not run planted docker, uv, npm or cmd", async () => {
    for (const analyzerId of ["docker-images", "npm-cache", "uv-cache"]) {
        for (const command of modules.commands.getAnalyzerCommands(analyzerId)) {
            await captureLaunches(() => modules.commands.executeAnalyzerCommand(analyzerId, command.id, true));
        }
    }
});

test("cancelling an analyzer command does not run a planted taskkill", async () => {
    heldExecFileReplies = [];
    const runner = modules.commands.createAnalyzerCommandRunner();
    const running = runner.execute("uv-cache", "uv-cache-dir");
    await new Promise((resolve) => setImmediate(resolve));
    const start = launches.length;
    runner.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    for (const reply of heldExecFileReplies) {
        reply();
    }
    heldExecFileReplies = undefined;
    await running.catch(() => {});
    const captured = launches.slice(start);
    assert.equal(captured.length, 1);
    assertNoPlantedProgram(captured[0]);
});
