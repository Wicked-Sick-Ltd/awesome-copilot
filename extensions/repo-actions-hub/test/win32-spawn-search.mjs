import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

// Windows executable search used by Node.js 22.23.4's bundled libuv 1.51.0.
// deps/uv/src/win/process.c search_path (lines 332-440), path_search_walk_ext
// (lines 246-285), and uv_spawn (lines 944-1017) pass the spawn cwd into that
// search. NeedCurrentDirectoryForExePathW("") is the cwd gate: an ExeName with
// no backslash returns TRUE unless NoDefaultCurrentDirectoryInExePath exists
// on the calling process (MSDN processenv; Wine 10.0 dlls/ntdll/loader.c
// RtlGetExePath, lines 4768-4774). The variable is read from the parent
// environment, not from the environment block passed to the child.

const PATH_SEPARATOR = delimiter;

export function needCurrentDirectoryForExePath(exeName = "") {
    if (String(exeName).includes("\\")) {
        return true;
    }
    return !Object.keys(process.env).some((key) => key.toLowerCase() === "nodefaultcurrentdirectoryinexepath");
}

function nameHasExtension(name) {
    const dot = name.lastIndexOf(".");
    return dot !== -1 && dot < name.length - 1;
}

function isUnc(dir) {
    return dir.length > 2 && (dir[0] === "\\" || dir[0] === "/") && (dir[1] === "\\" || dir[1] === "/");
}

function isDriveAbsolute(dir) {
    return dir.length > 2 && dir[1] === ":" && (dir[2] === "/" || dir[2] === "\\");
}

function isDriveRelative(dir) {
    return dir.length >= 2 && dir[1] === ":" && (dir.length < 3 || (dir[2] !== "/" && dir[2] !== "\\"));
}

function hostAbsolute(dir) {
    return isAbsolute(dir) || isDriveAbsolute(dir) || isUnc(dir);
}

function locateFile(candidate) {
    const normalized = candidate.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    let current = normalized.startsWith("/") ? "/" : "";
    for (const segment of segments) {
        const directory = current === "" ? "." : current;
        if (!existsSync(directory)) {
            return null;
        }
        let match = null;
        if (current !== "") {
            const exact = `${current === "/" ? "" : current}/${segment}`;
            if (existsSync(exact)) {
                match = segment;
                current = exact;
            }
        }
        if (!match) {
            const entries = readdirSync(directory);
            const found = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
            if (!found) {
                return null;
            }
            current = current === "/" ? `/${found}` : current === "" ? found : `${current}/${found}`;
        }
    }
    if (!current || !existsSync(current)) {
        return null;
    }
    const stats = statSync(current);
    if (!stats.isFile()) {
        return null;
    }
    return current;
}

function joinCandidate(dir, name, extension, cwd) {
    let cwdPrefix = cwd ?? "";
    let directory = dir;
    if (isUnc(directory) || isDriveAbsolute(directory) || (process.platform !== "win32" && directory.startsWith("/"))) {
        cwdPrefix = "";
    } else if (directory.startsWith("/") || directory.startsWith("\\")) {
        cwdPrefix = cwdPrefix.slice(0, 2);
    } else if (isDriveRelative(directory)) {
        if (cwdPrefix.length < 2 || cwdPrefix.slice(0, 2).toLowerCase() !== directory.slice(0, 2).toLowerCase()) {
            cwdPrefix = "";
        } else {
            directory = directory.slice(2);
        }
    }

    let result = "";
    if (cwdPrefix) {
        result += cwdPrefix;
        if (!/[\\/:]$/.test(cwdPrefix)) {
            result += "\\";
        }
    }
    if (directory) {
        result += directory;
        if (!/[\\/:]$/.test(directory)) {
            result += "\\";
        }
    }
    result += name;
    if (extension) {
        if (!name.endsWith(".")) {
            result += ".";
        }
        result += extension;
    }
    return locateFile(result);
}

function walkExtensions(dir, name, cwd, exactFirst) {
    if (exactFirst) {
        const exact = joinCandidate(dir, name, "", cwd);
        if (exact) {
            return exact;
        }
    }
    return joinCandidate(dir, name, "com", cwd) || joinCandidate(dir, name, "exe", cwd);
}

function splitSearchPath(pathValue) {
    if (!pathValue) {
        return [];
    }
    const entries = [];
    let dirEnd = 0;
    while (dirEnd < pathValue.length) {
        if (dirEnd !== 0 || pathValue[0] === PATH_SEPARATOR) {
            dirEnd += 1;
        }
        if (dirEnd >= pathValue.length) {
            break;
        }
        const dirStart = dirEnd;
        if (pathValue[dirStart] === '"' || pathValue[dirStart] === "'") {
            const quoteEnd = pathValue.indexOf(pathValue[dirStart], dirStart + 1);
            dirEnd = quoteEnd === -1 ? pathValue.length : quoteEnd;
        }
        const separator = pathValue.indexOf(PATH_SEPARATOR, dirEnd);
        dirEnd = separator === -1 ? pathValue.length : separator;
        if (dirEnd === dirStart) {
            continue;
        }
        let entry = pathValue.slice(dirStart, dirEnd);
        if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) {
            entry = entry.slice(1, -1);
        } else {
            if (entry.startsWith('"') || entry.startsWith("'")) {
                entry = entry.slice(1);
            }
            if (entry.endsWith('"') || entry.endsWith("'")) {
                entry = entry.slice(0, -1);
            }
        }
        if (entry) {
            entries.push(entry);
        }
    }
    return entries;
}

function pathFromEnvPairs(envPairs) {
    if (!Array.isArray(envPairs)) {
        return process.env.PATH ?? process.env.Path ?? "";
    }
    for (const pair of envPairs) {
        const separator = pair.indexOf("=");
        if (separator === -1) {
            continue;
        }
        if (pair.slice(0, separator).toLowerCase() === "path") {
            return pair.slice(separator + 1);
        }
    }
    return process.env.PATH ?? process.env.Path ?? "";
}

export function resolveWindowsApplication(file, cwd, envPairs) {
    const directory = cwd && cwd.length > 0 ? cwd : process.cwd();
    if (typeof file !== "string" || file.length === 0 || file === ".") {
        return null;
    }

    let nameStart = file.length;
    while (
        nameStart > 0 &&
        file[nameStart - 1] !== "\\" &&
        file[nameStart - 1] !== "/" &&
        file[nameStart - 1] !== ":"
    ) {
        nameStart -= 1;
    }
    const fileHasDir = nameStart !== 0;
    const name = file.slice(nameStart);
    const exactFirst = nameHasExtension(name);

    if (fileHasDir) {
        if (hostAbsolute(file)) {
            const direct = locateFile(file);
            if (direct) {
                return direct;
            }
        }
        return walkExtensions(file.slice(0, nameStart), name, directory, exactFirst);
    }

    if (needCurrentDirectoryForExePath("")) {
        const inCwd = walkExtensions("", file, directory, exactFirst);
        if (inCwd) {
            return inCwd;
        }
    }

    for (const entry of splitSearchPath(pathFromEnvPairs(envPairs))) {
        const found = walkExtensions(entry, file, directory, exactFirst);
        if (found) {
            return found;
        }
    }
    return null;
}

export function shellCommandLine(options) {
    if (!options?.shell) {
        return null;
    }
    const args = Array.isArray(options.args) ? options.args.slice(1) : [];
    const flag = args.findIndex((argument) => argument === "-c" || argument === "/c");
    if (flag === -1 || flag + 1 >= args.length) {
        return null;
    }
    let command = String(args[flag + 1]);
    if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) {
        command = command.slice(1, -1);
    }
    return command;
}

export function commandExecutable(command) {
    const trimmed = command.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed.startsWith('"')) {
        const end = trimmed.indexOf('"', 1);
        return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
    }
    return trimmed.split(/\s+/)[0];
}
