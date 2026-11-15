// Test loader: the notebook canvas connects to Copilot at import time.
// Tests substitute a workspace path so the cell runner can be invoked directly.

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return {
            shortCircuit: true,
            url: new URL("./copilot-sdk-stub.mjs", import.meta.url).href,
        };
    }
    return nextResolve(specifier, context);
}
