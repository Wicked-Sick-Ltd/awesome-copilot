import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const real = require("node:child_process");

function normalize(file, args, options) {
    let argv = [];
    let opts = {};
    if (Array.isArray(args)) {
        argv = args.map((arg) => String(arg));
        if (options && typeof options === "object") opts = options;
    } else if (args && typeof args === "object") {
        opts = args;
    }
    return {
        file: String(file),
        args: argv,
        cwd: opts.cwd == null ? null : String(opts.cwd),
        env: opts.env && typeof opts.env === "object" ? { ...opts.env } : null,
    };
}

function record(file, args, options) {
    const calls = globalThis.__gweExecFileCalls;
    if (!Array.isArray(calls)) return;
    calls.push(normalize(file, args, options));
}

const custom = Object.getOwnPropertySymbols(real.execFile).find((symbol) =>
    String(symbol).includes("promisify.custom"));

export function execFile(file, args, options, callback) {
    record(file, args, options);
    return real.execFile(file, args, options, callback);
}

if (custom) {
    execFile[custom] = function execFilePromisified(file, args, options) {
        record(file, args, options);
        return real.execFile[custom](file, args, options);
    };
}

export function execFileSync(file, args, options) {
    record(file, args, options);
    return real.execFileSync(file, args, options);
}

export function spawn(file, args, options) {
    record(file, args, options);
    return real.spawn(file, args, options);
}

export function spawnSync(file, args, options) {
    record(file, args, options);
    return real.spawnSync(file, args, options);
}

export const {
    _forkChild,
    ChildProcess,
    exec,
    execSync,
    fork,
} = real;

export default {
    ...real,
    execFile,
    execFileSync,
    spawn,
    spawnSync,
};
