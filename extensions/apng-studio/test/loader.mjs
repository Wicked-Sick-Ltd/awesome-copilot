export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return {
            format: "module",
            shortCircuit: true,
            url: new URL("./sdk-stub.mjs", import.meta.url).href,
        };
    }
    return nextResolve(specifier, context);
}
