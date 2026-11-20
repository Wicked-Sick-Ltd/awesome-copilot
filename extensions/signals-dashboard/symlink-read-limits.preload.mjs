import { registerHooks } from "node:module";
import { load, resolve } from "./symlink-read-limits.loader.mjs";

registerHooks({ resolve, load });
