// Test stand-in for @github/copilot-sdk/extension.
// The notebook canvas calls joinSession at import time; the tests need the
// runner functions without opening a Copilot session.

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

export async function joinSession() {
    const workspacePath = process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE;
    if (!workspacePath) {
        throw new Error("NOTEBOOK_CANVAS_TEST_WORKSPACE is not set");
    }
    return { workspacePath };
}
