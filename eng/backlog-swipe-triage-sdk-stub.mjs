// Mirrors @github/copilot-sdk@1.0.1 dist/canvas.js: handlers stay on the
// canvas object and are not rewritten. joinSession does not open a CLI
// connection; session.js forwards canvas.open and canvas.action.invoke
// parameters to those handlers unchanged.

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CanvasError";
    }
}

export function createCanvas(options) {
    const actionHandlers = new Map();
    const actions = options.actions?.map(({ handler, ...wire }) => {
        actionHandlers.set(wire.name, handler);
        return wire;
    });
    return {
        declaration: {
            id: options.id,
            displayName: options.displayName,
            description: options.description,
            inputSchema: options.inputSchema,
            actions,
        },
        open: options.open,
        onClose: options.onClose,
        actionHandlers,
    };
}

export async function joinSession(config = {}) {
    const canvas = config.canvases?.find((candidate) => candidate.declaration?.id === "backlog-swipe-triage");
    if (!canvas) {
        throw new Error("Backlog Swipe Triage canvas was not registered.");
    }
    globalThis.__backlogSwipeTriageCanvas = canvas;
    return {
        async send() {},
    };
}
