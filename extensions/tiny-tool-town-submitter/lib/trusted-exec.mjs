import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

function windowsExtensions() {
    // execFile cannot start .bat/.cmd without a shell, so only native executables qualify.
    const allowed = new Set([".EXE", ".COM"]);
    const listed = String(process.env.PATHEXT || ".COM;.EXE")
        .split(";")
        .map((ext) => ext.trim().toUpperCase())
        .filter((ext) => allowed.has(ext));
    return listed.length ? listed : [".EXE"];
}

function isInside(root, target) {
    const path = relative(root, target);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonical(path) {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

async function isExecutableFile(path) {
    try {
        if (!(await stat(path)).isFile()) return false;
        await access(path, isWindows ? constants.F_OK : constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve a command to an absolute path using only absolute PATH entries, skipping any
 * candidate that lives inside an untrusted directory. A bare command name must never reach
 * execFile: on Windows it is looked up in the child's working directory before PATH.
 */
export async function resolveTrustedExecutable(command, untrustedRoots = []) {
    const roots = await Promise.all(
        untrustedRoots.filter(Boolean).map(async (root) => [resolve(root), await canonical(root)]),
    );
    const names = isWindows ? windowsExtensions().map((ext) => `${command}${ext}`) : [command];
    const directories = String(process.env.PATH || "")
        .split(delimiter)
        .map((entry) => isWindows ? entry.replace(/^"(.*)"$/, "$1") : entry);

    for (const directory of directories) {
        if (!directory || !isAbsolute(directory)) continue;
        for (const name of names) {
            const candidate = join(resolve(directory), name);
            if (!(await isExecutableFile(candidate))) continue;
            const real = await canonical(candidate);
            if (roots.flat().some((root) => isInside(root, candidate) || isInside(root, real))) continue;
            return candidate;
        }
    }
    throw new Error(`${command} was not found on a trusted PATH entry.`);
}

export async function runTrusted(command, args, { untrustedRoots = [], timeout = 15000 } = {}) {
    const file = await resolveTrustedExecutable(command, untrustedRoots);
    const { stdout } = await execFileAsync(file, args, {
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });
    return stdout.trim();
}
