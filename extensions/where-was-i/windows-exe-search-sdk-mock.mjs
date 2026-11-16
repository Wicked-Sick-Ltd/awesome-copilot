// Test double for @github/copilot-sdk/extension. It records the canvas the
// extension registers and returns a session whose working directory the test
// controls. It does not launch Copilot.

export let joinedSessionOptions = null;

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export function createCanvas(config) {
    return config;
}

export async function joinSession(options) {
    joinedSessionOptions = options;
    return {
        workspacePath: process.env.WHERE_WAS_I_WORKSPACE || null,
        async send() {},
        rpc: {
            metadata: {
                async snapshot() {
                    return {
                        workingDirectory: process.env.WHERE_WAS_I_CWD || null,
                    };
                },
            },
        },
    };
}
