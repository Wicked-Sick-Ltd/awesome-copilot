// Test stand-in for @github/copilot-sdk/extension at the published 1.0.34 API.
// Built from package/dist/canvas.js (Canvas, CanvasError, createCanvas) and
// package/dist/extension.js (joinSession). joinSession does not resume a Copilot
// process: the extension calls it only to register canvases, and the host later
// invokes canvas.open(params) from CopilotSession.registerCanvases. This shim
// keeps that Canvas object and records it for the test.

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CanvasError";
    }

    static noHandler() {
        return new CanvasError(
            "canvas_action_no_handler",
            "No handler implemented for this canvas action",
        );
    }
}

class Canvas {
    constructor(options) {
        const actionHandlers = new Map();
        const wireActions = options.actions?.map(({ handler, ...wire }) => {
            actionHandlers.set(wire.name, handler);
            return wire;
        });
        this.declaration = {
            id: options.id,
            displayName: options.displayName,
            description: options.description,
            icon: options.icon,
            inputSchema: options.inputSchema,
            actions: wireActions,
        };
        this.open = options.open;
        this.onClose = options.onClose;
        this.actionHandlers = actionHandlers;
    }
}

export function createCanvas(options) {
    return new Canvas(options);
}

export async function joinSession(config = {}) {
    globalThis.__arcadeCanvasTestJoin = {
        canvases: config.canvases ?? [],
    };
    return {};
}
