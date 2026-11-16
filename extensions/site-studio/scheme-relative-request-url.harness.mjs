// Child process for scheme-relative-request-url.test.mjs.
// Loads the real Site Studio extension and opens its real loopback server.
// Exits 0 only when a scheme-relative request is answered with 400 and the
// process is still alive. Node's default unhandled-rejection behavior is
// left in place when argv mode is "default-exit".

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const markerPath = process.argv[3];
const extensionPath = process.argv[4];

if (!mode || !markerPath || !extensionPath) {
    console.error("usage: harness.mjs <survive|default-exit> <marker> <extension.mjs>");
    process.exit(2);
}

const stubUrl = new URL("./scheme-relative-request-url.sdk-stub.mjs", import.meta.url).href;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
            return { url: stubUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const rejections = [];
if (mode === "survive") {
    process.on("unhandledRejection", (reason) => {
        rejections.push(reason instanceof Error ? reason.stack || reason.message : String(reason));
    });
}

await import(pathToFileURL(extensionPath).href);

const config = globalThis.__siteStudioJoinConfig;
const canvas = config?.canvases?.[0];
if (!canvas?.open) {
    console.error("extension did not register a canvas open handler");
    process.exit(2);
}

const instanceId = "scheme-relative-request-url";
const opened = await canvas.open({
    instanceId,
    canvasId: "site-studio",
    session: { workingDirectory: process.cwd() },
});
const port = Number(new URL(opened.url).port);
if (!Number.isInteger(port) || port <= 0) {
    console.error(`canvas open did not bind a loopback port: ${opened?.url}`);
    process.exit(2);
}

const stateFile = path.join(path.dirname(extensionPath), "artifacts", "state.json");

function stateHash() {
    return createHash("sha256").update(readFileSync(stateFile)).digest("hex");
}

function rawRequest(method, target, timeoutMs) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        const chunks = [];
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.on("timeout", () => finish({ error: "timeout" }));
        socket.on("error", (error) => finish({ error: error.message }));
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const headerEnd = raw.indexOf("\r\n\r\n");
            const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
            const body = headerEnd === -1 ? "" : raw.slice(headerEnd + 4);
            const statusLine = header.split("\r\n", 1)[0] ?? "";
            const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(statusLine);
            finish({
                status: match ? Number(match[1]) : null,
                statusLine,
                body,
            });
        });
        socket.on("connect", () => {
            socket.write(
                `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
            );
        });
    });
}

function assertHealthy(label, response) {
    if (response.error || response.status !== 200) {
        throw new Error(`${label} expected HTTP 200, got ${JSON.stringify(response)}`);
    }
}

function assertInvalidUrl(label, response) {
    if (response.error || response.status !== 400) {
        throw new Error(`${label} expected HTTP 400, got ${JSON.stringify(response)}`);
    }
    let payload;
    try {
        payload = JSON.parse(response.body || "");
    } catch {
        throw new Error(`${label} expected a JSON body, got ${JSON.stringify(response.body)}`);
    }
    if (typeof payload.error !== "string" || payload.error.length === 0) {
        throw new Error(`${label} expected a JSON error string, got ${JSON.stringify(payload)}`);
    }
}

const healthy = await rawRequest("GET", "/api/state", 1000);
assertHealthy("warmup GET /api/state", healthy);
const before = stateHash();
const markerFd = openSync(markerPath, "w");
writeSync(markerFd, `${before}\n${stateFile}\n`);
fsyncSync(markerFd);
closeSync(markerFd);
process.stdout.write(`HEALTHY ${healthy.status}\nSTATE_SHA256 ${before}\n`);

const throwingTargets = [
    ["GET", "//"],
    ["GET", "///"],
    ["GET", "/\\"],
    ["GET", "//:"],
    ["GET", "//@"],
    ["GET", "//#"],
    ["GET", "//?"],
    ["GET", "http://"],
    ["GET", "http:///"],
    ["POST", "//"],
    ["HEAD", "//"],
];

const targets = mode === "default-exit" ? [["GET", "//"]] : throwingTargets;
const failures = [];

for (const [method, target] of targets) {
    const response = await rawRequest(method, target, mode === "default-exit" ? 2000 : 500);
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (rejections.length) {
        failures.push(`unhandled rejection after ${method} ${target}: ${rejections[0]}`);
        break;
    }
    try {
        if (method === "HEAD") {
            if (response.error || response.status !== 400) {
                throw new Error(`HEAD ${target} expected HTTP 400, got ${JSON.stringify(response)}`);
            }
        } else {
            assertInvalidUrl(`${method} ${target}`, response);
        }
    } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
    }
}

if (rejections.length === 0 && failures.length === 0) {
    const again = await rawRequest("GET", "/api/state", 1000);
    try {
        assertHealthy("follow-up GET /api/state", again);
    } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
    }
    if (stateHash() !== before) {
        failures.push("state file changed while handling the invalid request URL");
    }
}

if (canvas.onClose) {
    await canvas.onClose({ instanceId });
}

if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
} else {
    process.stdout.write("RESULT ok\n");
}
