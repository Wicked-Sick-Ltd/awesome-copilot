import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAnalyzerCommand, getAnalyzerCommands } from "../src/core/analyzer-commands.mjs";
import { analyzeUvCache } from "../src/analyzers/uv-cache.mjs";
import { renderHtml } from "../src/ui/renderer.mjs";

// Stand-in for uv.exe that resolves the cache directory with uv's precedence:
// --cache-dir (or UV_CACHE_DIR), then the nearest uv.toml above the working
// directory unless --no-config is passed, then %LOCALAPPDATA%\uv\cache.
const FAKE_UV_PRELOAD = String.raw`
const fs = require("node:fs");
const path = require("node:path");
require("node:module").runMain = function runFakeUv() {
    const [entry, ...rest] = process.argv.slice(1);
    const args = [path.basename(entry), ...rest];
    const optionIndex = args.indexOf("--cache-dir");
    const cliCacheDir = optionIndex === -1 ? undefined : args[optionIndex + 1];
    function projectCacheDir() {
        if (args.includes("--no-config")) return undefined;
        for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
            const configPath = path.join(directory, "uv.toml");
            if (fs.existsSync(configPath)) {
                const match = /^cache-dir\s*=\s*'(.*)'\s*$/m.exec(fs.readFileSync(configPath, "utf8"));
                return match?.[1];
            }
            if (path.dirname(directory) === directory) return undefined;
        }
    }
    const cacheDir = path.resolve(
        cliCacheDir
        ?? process.env.UV_CACHE_DIR
        ?? projectCacheDir()
        ?? path.join(process.env.LOCALAPPDATA, "uv", "cache"),
    );
    const subcommand = args.slice(0, 2).join(" ");
    if (subcommand === "cache dir") {
        process.stdout.write(cacheDir + "\n");
    } else if (subcommand === "cache clean") {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        process.stdout.write("Clearing cache at: " + cacheDir + "\n");
    } else if (subcommand === "cache prune") {
        process.stdout.write("Pruning cache at: " + cacheDir + "\n");
    } else {
        process.stderr.write("unsupported: " + args.join(" ") + "\n");
        process.exitCode = 2;
    }
};
`;

async function exists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), "uv-cache-command-test-"));
const localAppData = path.join(sandbox, "LocalAppData");
const managedCache = path.join(localAppData, "uv", "cache");
const repository = path.join(sandbox, "repository");
const victim = path.join(sandbox, "Documents");
const victimFile = path.join(victim, "important.txt");
const fakeBin = path.join(sandbox, "bin");
const fakeUvPreload = path.join(sandbox, "fake-uv.cjs");

const originalCwd = process.cwd();
const originalEnv = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR,
};

function restoreEnv() {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

async function resetDirectories() {
    await mkdir(victim, { recursive: true });
    await writeFile(victimFile, "keep");
    await mkdir(managedCache, { recursive: true });
    await writeFile(path.join(managedCache, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
}

try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(repository, { recursive: true });
    await writeFile(fakeUvPreload, FAKE_UV_PRELOAD);
    const fakeUvExecutable = path.join(fakeBin, "uv.exe");
    if (process.platform === "win32") {
        await copyFile(process.execPath, fakeUvExecutable);
    } else {
        await symlink(process.execPath, fakeUvExecutable);
    }
    await writeFile(
        path.join(repository, "uv.toml"),
        `cache-dir = '${victim.replaceAll("\\", "/")}'\n`,
    );

    process.env.LOCALAPPDATA = localAppData;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalEnv.PATH ?? ""}`;
    process.env.NODE_OPTIONS = `--require "${fakeUvPreload.replaceAll("\\", "/")}"`;
    delete process.env.UV_CACHE_DIR;
    process.chdir(repository);

    // A repository uv.toml must not redirect "Clear all uv cache entries".
    await resetDirectories();
    const cleanResult = await executeAnalyzerCommand("uv-cache", "uv-cache-clean", true, managedCache);
    assert.equal(
        await exists(victimFile),
        true,
        `uv cache clean removed the directory chosen by the repository uv.toml: ${cleanResult.output}`,
    );
    assert.equal(await exists(managedCache), false, "uv cache clean did not clear the standard uv cache");

    // An inherited UV_CACHE_DIR must not redirect it either.
    await resetDirectories();
    process.env.UV_CACHE_DIR = victim;
    await executeAnalyzerCommand("uv-cache", "uv-cache-clean", true, managedCache);
    assert.equal(await exists(victimFile), true, "uv cache clean removed the directory named by UV_CACHE_DIR");
    assert.equal(await exists(managedCache), false);
    delete process.env.UV_CACHE_DIR;

    // Prune and the read-only location command act on the same directory.
    await resetDirectories();
    const pruneResult = await executeAnalyzerCommand("uv-cache", "uv-cache-prune", true, managedCache);
    assert.equal(pruneResult.output.trim(), `Pruning cache at: ${managedCache}`);
    const dirResult = await executeAnalyzerCommand("uv-cache", "uv-cache-dir");
    assert.equal(dirResult.output.trim(), managedCache);

    // The confirmation shows the absolute target and the runner refuses a different one.
    const uvCommands = getAnalyzerCommands("uv-cache");
    for (const commandId of ["uv-cache-prune", "uv-cache-clean"]) {
        const command = uvCommands.find((item) => item.id === commandId);
        assert.equal(command.targetPath, managedCache);
        assert.ok(command.command.includes(managedCache));
        assert.equal("cwd" in command, false);
        assert.equal("env" in command, false);
    }
    await assert.rejects(
        executeAnalyzerCommand("uv-cache", "uv-cache-clean", true, victim),
        { code: "analyzer_command_target_changed" },
    );
    await assert.rejects(
        executeAnalyzerCommand("uv-cache", "uv-cache-clean", true),
        { code: "analyzer_command_target_changed" },
    );
    assert.equal(await exists(victimFile), true);
    assert.equal(await exists(managedCache), true);

    // The analyzer must not report the repository-chosen directory as uv's cache.
    const analysis = await analyzeUvCache({ directories: [], largestFiles: [] });
    assert.notEqual(analysis.configuredCachePath, victim);
    assert.equal(analysis.managedCachePath, managedCache);
    assert.equal(
        analysis.cleanupCommands.find((item) => item.id === "uv-cache-clean").targetPath,
        managedCache,
    );

    const html = renderHtml("test-token");
    assert.match(html, /id="analyzerCommandTarget"/);
    assert.match(html, /targetPath: active\.command\.targetPath/);
} finally {
    process.chdir(originalCwd);
    restoreEnv();
    await rm(sandbox, { recursive: true, force: true });
}

console.log("uv cache command tests passed");
