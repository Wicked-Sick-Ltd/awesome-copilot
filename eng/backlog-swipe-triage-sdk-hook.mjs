// Test hook: the extension connects to the Copilot CLI at import time.
// The stub keeps createCanvas's handler binding and skips that connection.
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return {
            shortCircuit: true,
            url: new URL("./backlog-swipe-triage-sdk-stub.mjs", import.meta.url).href,
        };
    }
    return nextResolve(specifier, context);
}
