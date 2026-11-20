// Opens the real Work Hub canvas server. Started by the test with the SDK
// loader already registered. Does not install an unhandledRejection listener:
// the extension process must survive a bad request-target on its own.

await import("./extension.mjs");

const joined = globalThis.__workHubJoin;
const canvas = joined?.config?.canvases?.[0];
if (!canvas || typeof canvas.open !== "function") {
    console.error("Work Hub did not register a canvas open handler.");
    process.exit(2);
}

const instanceId = "request-url-rejection";
const opened = await canvas.open({ instanceId, input: {} });
process.stdout.write(`READY ${opened.url}\n`);

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    if (!buffer.includes("CLOSE")) return;
    buffer = "";
    try {
        if (typeof canvas.onClose === "function") await canvas.onClose({ instanceId });
    } finally {
        process.exit(0);
    }
});
