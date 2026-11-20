export const sessionCapture = {
    hooks: null,
    canvas: null,
};

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export function createCanvas(definition) {
    return definition;
}

export async function joinSession(options) {
    sessionCapture.hooks = options.hooks;
    sessionCapture.canvas = options.canvases[0];
    return {
        async log() {},
        rpc: {
            metadata: {
                async snapshot() {
                    return { workingDirectory: undefined };
                },
            },
        },
    };
}
