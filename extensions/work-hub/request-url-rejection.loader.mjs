// Redirects the extension SDK import. The HTTP handler under test does not
// call into that package; joinSession only requires a parent CLI process.
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return {
            url: new URL("./request-url-rejection.sdk-stub.mjs", import.meta.url).href,
            shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
}
