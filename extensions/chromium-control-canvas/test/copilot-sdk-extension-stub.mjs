// Same module instance is used by extension.mjs (via the resolve hook) and by
// the test, so the canvas registered at load is visible here.
//
// createCanvas and CanvasError are the real SDK exports. joinSession is the
// only stand-in: the real one requires SESSION_ID and a Copilot parent
// process (extension.js in @github/copilot-sdk 1.0.1). It does not transform
// canvas action results; session.js returns the handler value unchanged.

import { createCanvas, CanvasError } from "../node_modules/@github/copilot-sdk/dist/extension.js";

export { createCanvas, CanvasError };

export let joinedConfig;

export function joinSession(config = {}) {
	joinedConfig = config;
	globalThis.__chromiumCanvasJoined = config;
	return Promise.resolve({
		log() {},
	});
}
