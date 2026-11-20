import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Windows resolves a bare program name, and relative PATH entries, against the
// working directory before PATH (both libuv's CreateProcess wrapper and cmd.exe
// do this). Every launch therefore uses an absolute program path and runs from
// System32 so a program or tool config planted in the caller's directory is
// never picked up.

const execFileAsync = promisify(execFile);
const SYSTEM_PROGRAMS = {
    "cmd.exe": ["cmd.exe"],
    "powershell.exe": ["WindowsPowerShell", "v1.0", "powershell.exe"],
    "taskkill.exe": ["taskkill.exe"],
};
const PATH_PROGRAMS = new Set(["docker.exe", "uv.exe", "npm.cmd"]);
// cmd.exe expands %VAR% and, with delayed expansion enabled in the registry, !VAR! inside quotes.
const CMD_UNSAFE_PATH_CHARACTERS = /["%!]/;

function launchError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function getSystemDirectory(env = process.env) {
    const systemRoot = env.SystemRoot || env.windir;
    if (typeof systemRoot !== "string" || !/^[a-z]:[\\/]/i.test(systemRoot)) {
        throw launchError("windows_system_directory_unavailable", "Cannot locate the Windows system directory");
    }
    return path.win32.join(systemRoot, "System32");
}

export function findProgramOnPath(fileName, env = process.env) {
    for (const rawEntry of String(env.PATH ?? "").split(path.delimiter)) {
        const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
        if (!path.isAbsolute(entry)) {
            continue;
        }
        const candidate = path.join(entry, fileName);
        try {
            if (statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Missing or unreadable PATH entries are skipped, as Windows does.
        }
    }
    throw launchError("ENOENT", `${fileName} was not found in an absolute PATH directory`);
}

export function resolveWindowsLaunch(program, args = [], options = {}) {
    const systemDirectory = getSystemDirectory();
    const launchOptions = { ...options, cwd: systemDirectory };
    if (SYSTEM_PROGRAMS[program]) {
        return { file: path.win32.join(systemDirectory, ...SYSTEM_PROGRAMS[program]), args, options: launchOptions };
    }
    if (!PATH_PROGRAMS.has(program)) {
        throw launchError("windows_program_unknown", `Unsupported program: ${program}`);
    }
    const programPath = findProgramOnPath(program);
    if (path.extname(programPath).toLowerCase() !== ".cmd") {
        return { file: programPath, args, options: launchOptions };
    }
    if (CMD_UNSAFE_PATH_CHARACTERS.test(programPath)) {
        throw launchError("windows_program_path_unsupported", `Cannot safely run ${programPath} through cmd.exe`);
    }
    if (!args.every((arg) => /^[\w.-]+$/.test(arg))) {
        throw launchError("windows_program_arguments_unsupported", `Cannot safely pass these arguments to ${program}`);
    }
    return {
        file: path.win32.join(systemDirectory, ...SYSTEM_PROGRAMS["cmd.exe"]),
        args: ["/d", "/s", "/c", `""${programPath}" ${args.join(" ")}"`],
        options: { ...launchOptions, windowsVerbatimArguments: true },
    };
}

export function execWindowsProgram(program, args, options, callback) {
    const launch = resolveWindowsLaunch(program, args, options);
    return execFile(launch.file, launch.args, launch.options, callback);
}

export async function execWindowsProgramAsync(program, args, options) {
    const launch = resolveWindowsLaunch(program, args, options);
    return execFileAsync(launch.file, launch.args, launch.options);
}

export function spawnWindowsProgram(program, args, options) {
    const launch = resolveWindowsLaunch(program, args, options);
    return spawn(launch.file, launch.args, launch.options);
}
