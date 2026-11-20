// Stand-in for @github/copilot-sdk/extension used only by the sandbox tests.
// joinSession returns the workspace path the test created. createCanvas records
// the canvas definition so tests can call the same action handlers the product uses.

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CanvasError";
    }
}

export function createCanvas(definition) {
    globalThis.__notebookCanvasUnderTest = definition;
    return definition;
}

export async function joinSession() {
    const workspacePath = process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE;
    if (!workspacePath) {
        throw new Error("NOTEBOOK_CANVAS_TEST_WORKSPACE is not set");
    }
    return { workspacePath };
}
