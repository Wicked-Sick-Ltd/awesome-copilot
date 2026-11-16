// Test stand-in for the Copilot host SDK. The loopback attack never enters
// joinSession; the stub only lets the real canvas open() start the real server.
export const canvases = [];

export function createCanvas(definition) {
    return definition;
}

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export async function joinSession(options) {
    canvases.push(...(options.canvases || []));
    return {
        log() {},
    };
}
