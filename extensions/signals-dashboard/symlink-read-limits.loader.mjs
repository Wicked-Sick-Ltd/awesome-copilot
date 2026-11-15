// Redirect the signals-dashboard extension onto fs wrappers and a local
// Copilot SDK stub. The wrapper is a no-op until a test arms a path.

import { createRequire } from "node:module";
import { wrapFs } from "./symlink-read-limits.trap-core.mjs";

const require = createRequire(import.meta.url);
const fsKeys = Object.keys(require("node:fs")).filter((key) => key !== "default");
const fspKeys = Object.keys(require("node:fs/promises")).filter((key) => key !== "default");

const coreUrl = new URL("./symlink-read-limits.trap-core.mjs", import.meta.url).href;
const stubUrl = new URL("./symlink-read-limits.sdk-stub.mjs", import.meta.url).href;
const VIRTUAL_FS = new URL("./symlink-read-limits.loader.mjs?signals-trap=fs", import.meta.url).href;
const VIRTUAL_FSP = new URL("./symlink-read-limits.loader.mjs?signals-trap=promises", import.meta.url).href;

const EXCLUDED = [
    "symlink-read-limits.trap-core.mjs",
    "symlink-read-limits.loader.mjs",
    "symlink-read-limits.preload.mjs",
    "symlink-read-limits.test.mjs",
    "symlink-read-limits.sdk-stub.mjs",
];

function shouldTrap(parentURL = "") {
    if (!parentURL.includes("/extensions/signals-dashboard/")) return false;
    return !EXCLUDED.some((name) => parentURL.includes(name));
}

function virtualSource(kind) {
    const specifier = kind === "promises" ? "node:fs/promises" : "node:fs";
    const keys = kind === "promises" ? fspKeys : fsKeys;
    const lines = keys
        .filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))
        .map((key) => `export const ${key} = api[${JSON.stringify(key)}];`);
    return `
import * as real from ${JSON.stringify(specifier)};
import { wrapFs } from ${JSON.stringify(coreUrl)};
const api = wrapFs(real, ${JSON.stringify(kind === "promises" ? "promises" : "fs")});
${lines.join("\n")}
export default api;
`;
}

const sources = new Map([
    [VIRTUAL_FS, virtualSource("fs")],
    [VIRTUAL_FSP, virtualSource("promises")],
]);

export function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: stubUrl, shortCircuit: true };
    }
    if (shouldTrap(context.parentURL)) {
        if (specifier === "node:fs" || specifier === "fs") {
            return { url: VIRTUAL_FS, shortCircuit: true };
        }
        if (specifier === "node:fs/promises" || specifier === "fs/promises") {
            return { url: VIRTUAL_FSP, shortCircuit: true };
        }
    }
    return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
    const source = sources.get(url);
    if (source !== undefined) {
        return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
}
