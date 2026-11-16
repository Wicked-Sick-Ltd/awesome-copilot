import { registerHooks } from "node:module";

const wrapperUrl = new URL("./windows-command-resolution-wrapper.mjs", import.meta.url).href;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if ((specifier === "node:child_process" || specifier === "child_process") && context.parentURL !== wrapperUrl) {
            return { url: wrapperUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

globalThis.__gweExecFileCalls = [];
