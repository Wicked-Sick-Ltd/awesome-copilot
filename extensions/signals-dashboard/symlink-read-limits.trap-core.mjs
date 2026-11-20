// Test harness for signals-dashboard symlink reads.
// Armed paths stay unchanged for metadata lookups. A later path-based read,
// write, or open that follows symlinks is swapped to the armed target first,
// so a check-then-use fix still observes the replacement.

import { unlinkSync, symlinkSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";

const SKIP = Symbol("skip-swap");
const traps = globalThis.__signalsReadTraps ||= new Map();

export function armReadTrap(path, target) {
    traps.set(path, target);
    return () => {
        if (traps.get(path) === target) traps.delete(path);
    };
}

// The next following write swaps the path. Reads leave the trap armed, so a
// read-then-write still observes the replacement on the write.
export function armWriteTrap(path, target) {
    traps.set(path, { target, writesOnly: true });
    return () => {
        const armed = traps.get(path);
        if (armed && armed.target === target && armed.writesOnly) traps.delete(path);
    };
}

export function pathKey(path) {
    if (typeof path === "string") return path;
    if (path instanceof URL && path.protocol === "file:") return fileURLToPath(path);
    return null;
}

export function openFollowsSymlink(flags) {
    if (flags === SKIP) return false;
    if (flags == null) return true;
    if (typeof flags === "object") return openFollowsSymlink(flags.flag ?? flags.flags);
    if (typeof flags === "number") {
        const bit = constants.O_NOFOLLOW;
        if (typeof bit === "number" && bit !== 0 && (flags & bit) === bit) return false;
        return true;
    }
    return true;
}

function flagFrom(options) {
    if (options == null || typeof options === "string" || typeof options === "function") return undefined;
    if (typeof options === "number") return options;
    if (typeof options === "object") return options.flag ?? options.flags;
    return undefined;
}

export function swapIfFollowing(path, flags, { write = false } = {}) {
    if (!openFollowsSymlink(flags)) return;
    const key = pathKey(path);
    if (!key || !traps.has(key)) return;
    const armed = traps.get(key);
    const target = typeof armed === "string" ? armed : armed.target;
    if (armed && typeof armed === "object" && armed.writesOnly && !write) return;
    traps.delete(key);
    try { unlinkSync(key); } catch { /* a missing path still gets the link */ }
    symlinkSync(target, key);
}

function wrap(realFn, pickFlags, { write = false } = {}) {
    return function wrapped(path, ...args) {
        const flags = pickFlags(args);
        if (flags !== SKIP) swapIfFollowing(path, flags, { write });
        return realFn.call(this, path, ...args);
    };
}

function readFlags(args) {
    return typeof args[0] === "function" ? undefined : flagFrom(args[0]);
}

function writeFlags(args) {
    return typeof args[1] === "function" ? undefined : flagFrom(args[1]);
}

function openFlags(args) {
    const flags = args[0];
    if (flags && typeof flags === "object") return flags.flag ?? flags.flags;
    return flags;
}

function streamFlags(args) {
    const options = args[0];
    if (options && typeof options === "object" && options.fd != null) return SKIP;
    if (typeof options === "string" || options == null) return undefined;
    if (typeof options === "object") return options.flags ?? options.flag;
    return undefined;
}

export function wrapFs(real, kind) {
    const api = {};
    for (const key of Object.keys(real)) {
        if (key === "default") continue;
        api[key] = real[key];
    }
    if (typeof real.readFile === "function") api.readFile = wrap(real.readFile, readFlags);
    if (typeof real.writeFile === "function") api.writeFile = wrap(real.writeFile, writeFlags, { write: true });
    if (typeof real.appendFile === "function") api.appendFile = wrap(real.appendFile, writeFlags, { write: true });
    if (typeof real.open === "function") api.open = wrap(real.open, openFlags);
    if (typeof real.readFileSync === "function") api.readFileSync = wrap(real.readFileSync, readFlags);
    if (typeof real.writeFileSync === "function") api.writeFileSync = wrap(real.writeFileSync, writeFlags, { write: true });
    if (typeof real.appendFileSync === "function") api.appendFileSync = wrap(real.appendFileSync, writeFlags, { write: true });
    if (typeof real.openSync === "function") api.openSync = wrap(real.openSync, openFlags);
    if (typeof real.createReadStream === "function") api.createReadStream = wrap(real.createReadStream, streamFlags);
    if (typeof real.createWriteStream === "function") api.createWriteStream = wrap(real.createWriteStream, streamFlags, { write: true });
    if (kind === "fs" && real.promises) api.promises = wrapFs(real.promises, "promises");
    return api;
}
