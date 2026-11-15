import { registerHooks } from "node:module";

const stubHref = new URL("./sdk-stub.mjs", import.meta.url).href;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
            return {
                url: stubHref,
                shortCircuit: true,
            };
        }
        return nextResolve(specifier, context);
    },
});
