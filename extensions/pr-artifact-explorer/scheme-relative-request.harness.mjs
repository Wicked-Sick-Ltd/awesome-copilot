import { startInstance } from "./server.mjs";

// Starts the real canvas loopback server and prints only its port.
// This process must not install an unhandledRejection or uncaughtException
// listener: the canvas extension does not install one either.
const entry = await startInstance("scheme-relative-request", null, () => {});
const port = new URL(entry.origin).port;
process.stdout.write(`READY ${port}\n`);
setInterval(() => {}, 2 ** 30);
