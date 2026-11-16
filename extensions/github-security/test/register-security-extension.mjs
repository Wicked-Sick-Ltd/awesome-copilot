import { register } from "node:module";

register(new URL("./security-extension-hook.mjs", import.meta.url).href, import.meta.url);
