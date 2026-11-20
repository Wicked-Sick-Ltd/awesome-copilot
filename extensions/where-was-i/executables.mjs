import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

// On Windows, spawning a bare command name searches the child's working directory
// before PATH, so a git.exe committed to the opened worktree would run instead of
// the installed one. Commands are therefore resolved here to an absolute path from
// absolute PATH entries only, and never to a file inside the directories the
// command is about to run in.

const WINDOWS_DIRECT_EXTENSIONS = [".COM", ".EXE"];

function canonical(path) {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

function isInside(root, candidate) {
    const relativePath = relative(root, candidate);
    return relativePath === ""
        || (relativePath !== ".."
            && !relativePath.startsWith("..\\")
            && !relativePath.startsWith("../")
            && !isAbsolute(relativePath));
}

function isRunnableFile(path) {
    try {
        if (!statSync(path).isFile()) return false;
        if (process.platform !== "win32") accessSync(path, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function windowsExtensions() {
    // execFile cannot launch .cmd/.bat without a shell, so only direct executables count.
    const configured = (process.env.PATHEXT || ".COM;.EXE")
        .split(";")
        .map((ext) => ext.trim().toUpperCase())
        .filter((ext) => WINDOWS_DIRECT_EXTENSIONS.includes(ext));
    return configured.length ? configured : WINDOWS_DIRECT_EXTENSIONS;
}

export function resolveExecutable(command, excludedRoots = []) {
    const excluded = excludedRoots.filter(Boolean).map(canonical);
    const names = process.platform === "win32"
        ? windowsExtensions().map((ext) => `${command}${ext}`)
        : [command];
    const pathValue = process.env.PATH ?? process.env.Path ?? "";

    for (const rawDir of pathValue.split(delimiter)) {
        const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
        if (!dir || !isAbsolute(dir)) continue;
        for (const name of names) {
            const candidate = join(dir, name);
            if (!isRunnableFile(candidate)) continue;
            let resolved;
            try {
                resolved = realpathSync(candidate);
            } catch {
                continue;
            }
            if (!isAbsolute(resolved)) continue;
            if (excluded.some((root) => isInside(root, resolved))) continue;
            return resolved;
        }
    }
    throw new Error(`Could not find ${command} on PATH.`);
}
