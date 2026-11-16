import { register } from "node:module";

// Installed before the extension module graph loads so the canvas entry can
// be imported without a Copilot parent process.
register(new URL("./request-url-rejection.loader.mjs", import.meta.url));
