// Stand-in for @github/copilot-sdk/extension at the version the extension
// manifest requests ("latest", resolved as 1.0.34). createCanvas keeps the
// open handler it was given, matching package/dist/canvas.js. joinSession
// only records that config so the test can call the real canvas open hook.
// The published SDK does not register an unhandledRejection listener.

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CanvasError";
    }
}

export class Canvas {
    constructor(options) {
        this.declaration = {
            id: options.id,
            displayName: options.displayName,
            description: options.description,
        };
        this.open = options.open;
        this.onClose = options.onClose;
    }
}

export function createCanvas(options) {
    return new Canvas(options);
}

export async function joinSession(config = {}) {
    globalThis.__siteStudioJoinConfig = config;
    return {
        workspacePath: process.env.SITE_STUDIO_WORKSPACE || process.cwd(),
    };
}
