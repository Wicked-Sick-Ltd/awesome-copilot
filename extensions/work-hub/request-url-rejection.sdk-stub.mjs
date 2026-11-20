// Stand-in for @github/copilot-sdk 1.0.34 dist/canvas.js and dist/extension.js.
// createCanvas stores the caller's open/onClose the way Canvas does
// (dist/canvas.js). joinSession cannot run here: dist/extension.js throws
// unless SESSION_ID is set and a parent process is connected. The stub keeps
// the canvas callbacks the extension registered and returns them to the test.

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CanvasError";
    }
}

export class Canvas {
    constructor(options) {
        this.open = options.open;
        this.onClose = options.onClose;
        this.declaration = {
            id: options.id,
            displayName: options.displayName,
            description: options.description,
        };
    }
}

export function createCanvas(options) {
    return new Canvas(options);
}

export async function joinSession(config = {}) {
    const session = {
        async send() {
            return undefined;
        },
    };
    globalThis.__workHubJoin = { config, session };
    return session;
}
