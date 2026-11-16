import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(import.meta.url);
const stateName = join(".github", "modernize", "canvas-default.json");

// Request targets the HTTP parser delivers to req.url and that
// `new URL(target, "http://127.0.0.1")` rejects. Every canvas route
// (GET /, GET /events, POST /api/configure, POST /api/step, POST /api/refresh)
// parses the target on the same line before its try, so one rejection
// crashes the process for all of them.
const crashingTargets = [
    { method: "GET", target: "//" },
    { method: "POST", target: "//", body: "{}" },
    { method: "GET", target: "///" },
    { method: "GET", target: "//:" },
    { method: "GET", target: "//?" },
    { method: "GET", target: "//#" },
    { method: "GET", target: "////" },
    { method: "PUT", target: "//" },
    { method: "DELETE", target: "//" },
    { method: "OPTIONS", target: "//" },
    { method: "HEAD", target: "//" },
];

if (process.env.MW_SCHEME_RELATIVE_CHILD === "1") {
    const { createInstanceServer } = await import("../lib/server.mjs");
    const workspace = process.argv[2];
    const marker = process.argv[3];
    const { appendFile } = await import("node:fs/promises");
    const touched = async (name) => {
        await appendFile(marker, `${name}\n`);
        return { touched: name };
    };
    const record = await createInstanceServer({
        workspace,
        stateId: "default",
        initialConfig: {},
        onConfigure: () => touched("configure"),
        onSetStep: () => touched("step"),
        onRefresh: () => touched("refresh"),
    });
    process.stdout.write(`READY ${new URL(record.url).port}\n`);
    setInterval(() => {}, 1 << 30);
} else {
    test("ordinary GET / keeps the canvas process up and writes no workflow state", async () => {
        await withServer(async ({ port, workspace }) => {
            const page = await sendRaw(port, { method: "GET", target: "/" });
            assert.equal(statusOf(page), 200);
            assert.match(headersOf(page), /content-type: text\/html/i);
            await assert.rejects(access(join(workspace, stateName)));
            await assert.rejects(access(join(workspace, "callbacks.log")));
        });
    });

    for (const spec of crashingTargets) {
        test(`${spec.method} ${JSON.stringify(spec.target)} returns 400 and the canvas process keeps serving`, async () => {
            await withServer(async ({ port, workspace, stderr }) => {
                let raw;
                try {
                    raw = await sendRaw(port, spec);
                } catch (error) {
                    assert.fail(
                        `${spec.method} ${JSON.stringify(spec.target)} produced no HTTP response (${error.message}).\n${stderr()}`,
                    );
                }
                assert.equal(
                    statusOf(raw),
                    400,
                    `expected 400 from the handler, got:\n${raw}\n${stderr()}`,
                );
                assert.match(headersOf(raw), /content-type: application\/json/i);
                const payload = bodyOf(raw);
                if (spec.method !== "HEAD") {
                    const parsed = JSON.parse(payload || "null");
                    assert.equal(typeof parsed?.error, "string");
                    assert.ok(parsed.error.length > 0);
                }

                const page = await sendRaw(port, { method: "GET", target: "/" });
                assert.equal(statusOf(page), 200, `canvas stopped serving after the rejected target:\n${stderr()}`);
                assert.match(headersOf(page), /content-type: text\/html/i);
                await assert.rejects(access(join(workspace, stateName)), "rejected request wrote workflow state");
                await assert.rejects(access(join(workspace, "callbacks.log")), "rejected request ran a workflow callback");
            });
        });
    }
}

async function withServer(run) {
    const workspace = await mkdtemp(join(tmpdir(), "modernization-workflow-"));
    const marker = join(workspace, "callbacks.log");
    const child = spawn(process.execPath, [scriptPath, workspace, marker], {
        env: { ...process.env, MW_SCHEME_RELATIVE_CHILD: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    try {
        const port = await readyPort(child, () => stderr);
        await run({ port, workspace, stderr: () => stderr });
        assert.equal(child.exitCode, null, `canvas process exited.\n${stderr}`);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (child.exitCode === null && child.signalCode === null) {
            await Promise.race([
                once(child, "exit"),
                new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        await rm(workspace, { recursive: true, force: true });
    }
}

function readyPort(child, stderr) {
    return new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => {
            reject(new Error(`server did not listen\n${stderr()}`));
        }, 5000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            out += chunk;
            const match = out.match(/READY (\d+)/);
            if (!match) return;
            clearTimeout(timer);
            resolve(Number(match[1]));
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`server exited before listening (${code ?? signal})\n${stderr()}`));
        });
    });
}

function sendRaw(port, { method, target, body }) {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("timed out waiting for the response"));
        }, 2000);
        const chunks = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.on("close", () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        const payload = body ?? "";
        const headers = [
            `${method} ${target} HTTP/1.1`,
            "Host: 127.0.0.1",
            "Connection: close",
        ];
        if (body !== undefined) {
            headers.push(`Content-Length: ${Buffer.byteLength(payload)}`);
            headers.push("Content-Type: application/json");
        }
        socket.once("connect", () => {
            // socket.end() here delivers the request and FIN together, and this
            // Node HTTP server drops that request without a response. Leave the
            // write side open; the server closes it after Connection: close.
            socket.write(`${headers.join("\r\n")}\r\n\r\n${payload}`);
        });
    });
}

function headersOf(raw) {
    return raw.slice(0, raw.indexOf("\r\n\r\n"));
}

function bodyOf(raw) {
    const start = raw.indexOf("\r\n\r\n");
    if (start === -1) return "";
    const headers = raw.slice(0, start);
    const rest = raw.slice(start + 4);
    if (!/transfer-encoding:\s*chunked/i.test(headers)) return rest;
    let offset = 0;
    let body = "";
    while (offset < rest.length) {
        const lineEnd = rest.indexOf("\r\n", offset);
        if (lineEnd === -1) break;
        const size = Number.parseInt(rest.slice(offset, lineEnd), 16);
        if (!Number.isFinite(size) || size === 0) break;
        const dataStart = lineEnd + 2;
        body += rest.slice(dataStart, dataStart + size);
        offset = dataStart + size + 2;
    }
    return body;
}

function statusOf(raw) {
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
    return match ? Number(match[1]) : null;
}
