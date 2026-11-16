import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "sdk-extension-stub.mjs"),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@github/copilot-sdk/extension") {
    return { url: stubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
