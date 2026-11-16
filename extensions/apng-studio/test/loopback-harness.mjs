// Starts the real APNG Studio canvas server. Prints only the port. Does not
// install an unhandledRejection listener, so a rejection exits this process
// the same way Node's default mode exits an extension process.
import { createInterface } from "node:readline";
import { canvases } from "./sdk-stub.mjs";

await import("../extension.mjs");

const instanceId = "loopback-request-target";
const canvas = canvases[0];
const opened = await canvas.open({
    instanceId,
    input: { projectId: "loopback-request-target" },
});
process.stdout.write(`PORT ${new URL(opened.url).port}\n`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    if (line === "close") {
        await canvas.onClose({ instanceId });
        process.exit(0);
    }
}
