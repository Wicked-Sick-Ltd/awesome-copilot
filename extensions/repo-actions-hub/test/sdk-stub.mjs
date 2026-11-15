// Stand-in for @github/copilot-sdk/extension at the published 1.0.34 shape.
// createCanvas stores the extension's open function unchanged (dist/canvas.js),
// and joinSession only resumes the host session (dist/extension.js). Neither
// function reads the canvas HTTP body. The stub skips the parent-process RPC
// session so the real extension module can load; the HTTP server under test is
// the one extension.mjs binds.

export const captured = {
    config: null,
};

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export function createCanvas(options) {
    const actionHandlers = new Map();
    for (const action of options.actions ?? []) {
        actionHandlers.set(action.name, action.handler);
    }
    return {
        declaration: {
            id: options.id,
            displayName: options.displayName,
            description: options.description,
            icon: options.icon,
            inputSchema: options.inputSchema,
        },
        open: options.open,
        onClose: options.onClose,
        actionHandlers,
    };
}

export async function joinSession(config) {
    captured.config = config;
    return {
        rpc: {
            metadata: {
                snapshot: async () => ({ workingDirectory: process.cwd() }),
            },
        },
        log: async () => {},
    };
}
