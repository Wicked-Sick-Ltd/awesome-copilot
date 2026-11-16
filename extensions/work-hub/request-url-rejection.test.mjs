// Fails while a scheme-relative request-target throws outside handleRequest's
// try/catch and createServer does not catch that rejection.
//
// Run:
//   node --test extensions/work-hub/request-url-rejection.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function startServer() {
    const child = spawn(process.execPath, [
        "--import",
        path.join(here, "request-url-rejection.register.mjs"),
        path.join(here, "request-url-rejection.child.mjs"),
    ], {
        cwd: here,
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.stdin.on("error", () => {});

    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 5000);
        child.on("exit", (code, signal) => {
            if (stdout.includes("READY ")) return;
            clearTimeout(timer);
            reject(new Error(`server exited ${code ?? signal} before listening\nstderr:\n${stderr}`));
        });
        child.stdout.on("data", () => {
            const match = stdout.match(/READY (http:\/\/127\.0\.0\.1:\d+\/)/);
            if (!match) return;
            clearTimeout(timer);
            resolve(match[1]);
        });
    });

    return {
        child,
        ready,
        stderr: () => stderr,
        async stop() {
            if (child.exitCode !== null || child.signalCode) return child.exitCode;
            child.stdin.write("CLOSE\n");
            return await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    resolve(null);
                }, 2000);
                child.once("exit", (code) => {
                    clearTimeout(timer);
                    resolve(code);
                });
            });
        },
    };
}

function request(baseUrl, method, target) {
    const port = new URL(baseUrl).port;
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(port), "127.0.0.1");
        const chunks = [];
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`${method} ${target} timed out`));
        }, 2000);
        socket.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        socket.on("connect", () => {
            socket.end(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        });
    });
}

function statusOf(raw) {
    const line = raw.split("\r\n", 1)[0] || "";
    const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(line);
    assert.ok(match, `expected an HTTP status line, received ${JSON.stringify(raw.slice(0, 180))}`);
    return Number(match[1]);
}

function jsonBody(raw) {
    const splitAt = raw.indexOf("\r\n\r\n");
    assert.notEqual(splitAt, -1, "expected an HTTP body");
    const body = raw.slice(splitAt + 4);
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        assert.fail(`expected a JSON body, received ${JSON.stringify(body.slice(0, 180))}`);
    }
    return parsed;
}

test("invalid request targets get 400 and the canvas process stays up", async () => {
    const server = startServer();
    try {
        const baseUrl = await server.ready;
        const home = await request(baseUrl, "GET", "/");
        assert.equal(statusOf(home), 200);
        assert.match(home, /Work Hub/);

        const targets = [
            ["GET", "//"],
            ["GET", "///"],
            ["GET", "//?"],
            ["GET", "/\\"],
            ["POST", "//"],
        ];
        for (const [method, target] of targets) {
            let raw;
            try {
                raw = await request(baseUrl, method, target);
            } catch (error) {
                assert.fail(`${method} ${target} failed (${error.message}). exit=${server.child.exitCode}\n${server.stderr()}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(server.child.exitCode, null, `${method} ${target} killed the canvas process\n${server.stderr()}`);
            assert.equal(statusOf(raw), 400, `${method} ${target} must be rejected as a bad request, received ${JSON.stringify(raw.slice(0, 180))}\n${server.stderr()}`);
            const body = jsonBody(raw);
            assert.equal(typeof body.error, "string");
            assert.ok(body.error.length > 0);
        }

        const again = await request(baseUrl, "GET", "/");
        assert.equal(statusOf(again), 200, "the process must still serve the canvas after a bad request-target");
        assert.equal(server.child.exitCode, null);
        assert.equal(server.stderr().includes("ERR_INVALID_URL"), false);

        const code = await server.stop();
        assert.equal(code, 0);
    } finally {
        if (server.child.exitCode === null && !server.child.signalCode) {
            server.child.kill("SIGKILL");
        }
    }
});
