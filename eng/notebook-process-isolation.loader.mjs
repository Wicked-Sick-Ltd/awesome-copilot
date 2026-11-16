// Load hook so tests can call the canvas runner without a Copilot session.
// The canvas module is otherwise unchanged: its handleCanvasAction is re-exported.

const SDK_SPECIFIER = "@github/copilot-sdk/extension";
const CANVAS_SUFFIX = "/extensions/jupyter-notebooks/notebook-canvas.mjs";

export async function resolve(specifier, context, nextResolve) {
    if (specifier === SDK_SPECIFIER) {
        return {
            shortCircuit: true,
            url: new URL("./notebook-process-isolation.sdk-mock.mjs", import.meta.url).href,
        };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.endsWith(CANVAS_SUFFIX)) {
        const loaded = await nextLoad(url, { ...context, format: "module" });
        const original = typeof loaded.source === "string"
            ? loaded.source
            : Buffer.from(loaded.source).toString("utf8");
        return {
            format: "module",
            shortCircuit: true,
            source: `${original}\nexport { handleCanvasAction };\n`,
        };
    }
    return nextLoad(url, context);
}
