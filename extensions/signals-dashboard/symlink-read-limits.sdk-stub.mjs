// Stand-in for @github/copilot-sdk/extension. The package is not installed in
// this checkout. joinSession only receives the canvas object the extension
// already built; the scan and stash handlers under test are those functions.

export function createCanvas(canvas) {
    return canvas;
}

export async function joinSession(options) {
    const canvas = options?.canvases?.[0];
    globalThis.__signalsDashboardCanvas = canvas;
    return { canvases: options?.canvases ?? [] };
}
