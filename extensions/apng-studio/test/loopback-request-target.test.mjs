// Spec for the loopback request-target crash in extensions/apng-studio/extension.mjs.
// These tests fail while handleRequest builds `new URL(req.url, "http://localhost")`
// outside its try/catch and startServer does not catch the handler promise.
//
// Run:
//   node --test extensions/apng-studio/test/loopback-request-target.test.mjs
//
// shareRequest (the LAN "send to phone" server) is not covered. Its URL
// constructor already sits inside that handler's try/catch, so this crash is
// specific to the loopback server started by the canvas open path.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./loopback-harness.mjs", import.meta.url));
const register = fileURLToPath(new URL("./register-sdk-stub.mjs", import.meta.url));
const projectDir = fileURLToPath(new URL("../artifacts/loopback-request-target", import.meta.url));

// Request-targets Node's HTTP parser delivers to the handler and that
// `new URL(target, "http://localhost")` rejects. A fix that special-cases only
// "//" still fails the rest.
const throwingTargets = [
    "//",
    "///",
    "//?",
    "///?",
    "/\\",
    "/\\?",
    "//#",
    "///#",
    "//:",
    "/\\/",
    "//?x=1",
    "//?k=placeholder",
    "//%2f",
    "//%5c",
    "////",
    "///?x=1",
    "///:",
    "///%2f",
    "///%5c",
    "/\\?x=1",
    "/\\#",
    "/\\:",
    "/\\%2f",
    "/\\%5c",
    "//%",
    "//<",
    "//>",
    "//@",
    "//[",
    "//\\",
    "//]",
    "//^",
    "//|",
];

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function rawRequest(port, { method, target, version }) {
    const payload = `${method} ${target} ${version}\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
    return new Promise((resolve) => {
        const chunks = [];
        let settled = false;
        const finish = (extra) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString("utf8");
            const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1]);
            resolve({ status: Number.isFinite(status) ? status : null, raw, ...extra });
        };
        const timer = setTimeout(() => {
            socket.destroy();
            finish({ error: "timeout" });
        }, 2000);
        // Leave the write side open until the server finishes. Ending it
        // immediately races an async handler and can drop the response.
        const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(payload));
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", (err) => finish({ error: err.message }));
        socket.on("close", () => finish({ error: null }));
    });
}

function startServer() {
    const child = spawn(process.execPath, ["--import", register, harness], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const port = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`server did not listen\n${stdout}\n${stderr}`));
        }, 10000);
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited ${code} before listening\n${stderr}`));
        });
        child.stdout.on("data", () => {
            const match = /PORT (\d+)/.exec(stdout);
            if (!match) return;
            clearTimeout(timer);
            child.removeAllListeners("exit");
            resolve(Number(match[1]));
        });
    });
    return {
        child,
        port,
        stderr: () => stderr,
        async close() {
            if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
            child.stdin.write("close\n");
            return await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    resolve(null);
                }, 3000);
                child.once("exit", (code) => {
                    clearTimeout(timer);
                    resolve(code);
                });
            });
        },
    };
}

test("invalid loopback request-targets return 400 and the extension process stays up", async () => {
    const server = startServer();
    try {
        const port = await server.port;
        const cases = [
            ...throwingTargets.map((target) => ({ method: "GET", target, version: "HTTP/1.1" })),
            ...methods.filter((method) => method !== "GET").map((method) => ({ method, target: "//", version: "HTTP/1.1" })),
            { method: "GET", target: "//", version: "HTTP/1.0" },
        ];
        for (const item of cases) {
            const result = await rawRequest(port, item);
            assert.equal(
                result.status,
                400,
                `${item.method} ${JSON.stringify(item.target)} ${item.version} should be 400 without a capability token, got ${result.status} (${result.error || "no error"})\n${server.stderr()}`
            );
            assert.equal(server.child.exitCode, null, `extension process exited after ${item.method} ${JSON.stringify(item.target)}\n${server.stderr()}`);
        }

        const page = await rawRequest(port, { method: "GET", target: "/", version: "HTTP/1.1" });
        assert.equal(page.status, 200, `public renderer should still load after rejected targets\n${server.stderr()}`);
        const state = await rawRequest(port, { method: "GET", target: "/state", version: "HTTP/1.1" });
        assert.equal(state.status, 403, "project state still requires the capability token");
        await assert.rejects(access(projectDir), "rejected request-targets must not create a project directory");

        const code = await server.close();
        assert.equal(code, 0, `extension process exit ${code}\n${server.stderr()}`);
    } finally {
        if (server.child.exitCode === null && server.child.signalCode === null) {
            server.child.kill("SIGKILL");
        }
    }
});
