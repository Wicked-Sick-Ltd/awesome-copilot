import { readFile } from "node:fs/promises";

const stubUrl = new URL("./copilot-sdk-stub.mjs", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@github/copilot-sdk/extension") {
		return { url: stubUrl.href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.endsWith("/extensions/github-security/extension.mjs")) {
		const source = await readFile(new URL(url), "utf8");
		return {
			format: "module",
			shortCircuit: true,
			source: `${source}
export {
	CodeSnippetLoader,
	SessionInfo,
	handleCodeSnippetRequest
};
`
		};
	}
	return nextLoad(url, context);
}
