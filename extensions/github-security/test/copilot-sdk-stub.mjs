// Stand-in for @github/copilot-sdk/extension so the Security canvas module can
// load without a live Copilot session. joinSession is only the host handshake;
// the git and ssh calls under test happen later, inside the canvas code.
export function createCanvas(definition) {
	return definition;
}

export async function joinSession() {
	return {
		on() {},
		workspacePath: undefined
	};
}
