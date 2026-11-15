// Test stand-in for the Copilot session API. The loopback server starts before
// joinSession, and the body handlers under test do not call it unless a PR is
// already selected. This stub only lets extension.mjs finish loading.
export function createCanvas(definition) {
	return definition;
}

export function joinSession() {
	return {
		send() {},
	};
}
