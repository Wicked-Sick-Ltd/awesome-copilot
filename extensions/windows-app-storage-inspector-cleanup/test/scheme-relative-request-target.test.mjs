// Fails while the canvas server turns an invalid request-target into an
// unhandled rejection. Passes once that constructor failure is answered
// with HTTP 400 and the process keeps serving.
//
// Run:
//   node extensions/windows-app-storage-inspector-cleanup/test/scheme-relative-request-target.test.mjs
//
// The server refuses to listen unless process.platform is win32. The child
// sets that property so this Linux runner executes the same branch the
// Windows product runs after the platform check. The HTTP parser, Host
// check, and URL constructor are the real ones.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"];

// Each of these survives Node's HTTP parser and makes `new URL(request.url, "http://127.0.0.1")` throw.
const invalidRequestTargets = [
    "//",
    "///",
    "////",
    "//?",
    "//#",
    "//:",
    "//[",
    "//]",
    "//@",
    "//\\",
    "// ",
    "//user@",
    "//user:pass@",
    "/\\",
    "http://",
    "http:///",
    "https://",
    "https:///",
    "ws://",
    "wss://",
    "ftp://",
    "file://:",
    "file://[",
    "//%00",
    "http://%",
    "https://[",
];

if (process.env.STORAGE_INSPECTOR_URL_CHILD === "1") {
    await runChild();
} else {
    try {
        await runParent();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

async function runChild() {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { startCanvasServer } = await import("../src/api/server.mjs");
    const service = new Proxy({}, {
        get(_target, property) {
            if (property === "then") {
                return undefined;
            }
            return () => {
                process.stderr.write(`SERVICE_CALL ${String(property)}\n`);
                if (property === "subscribe") {
                    return () => {};
                }
                if (property === "getState") {
                    return { scan: { status: "idle" } };
                }
                return {};
            };
        },
    });
    const canvas = await startCanvasServer(service, async () => {
        process.stderr.write("SERVICE_CALL requestAgentInvestigation\n");
        return {};
    }, async () => {
        process.stderr.write("SERVICE_CALL cancelAgentInvestigation\n");
        return {};
    });
    const canvasUrl = new URL(canvas.url);
    process.stdout.write(`${JSON.stringify({
        port: Number(canvasUrl.port),
        token: canvasUrl.searchParams.get("token"),
    })}\n`);
    await new Promise((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
    });
    await canvas.close();
}

async function runParent() {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, STORAGE_INSPECTOR_URL_CHILD: "1" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const readyLine = await new Promise((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => reject(new Error(`canvas server did not start\n${stderr}`)), 5000);
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`canvas server exited before ready: code ${code} signal ${signal}\n${stderr}`));
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const newline = stdout.indexOf("\n");
            if (newline >= 0) {
                clearTimeout(timer);
                child.removeAllListeners("exit");
                resolve(stdout.slice(0, newline));
            }
        });
    });
    const ready = JSON.parse(readyLine);
    const host = `127.0.0.1:${ready.port}`;
    try {
        const forbidden = await sendRaw({
            port: ready.port,
            method: "GET",
            target: "//",
            host: "attacker.example",
        });
        assert.equal(forbidden.status, 403, "a mismatched Host is rejected before URL parsing");
        assert.equal(forbidden.json.code, "request_forbidden");
        assert.equal(child.exitCode, null, "a mismatched Host must not exit the process");
        assert.deepEqual(serviceCallsSince(stderr).filter((name) => name !== "subscribe"), []);

        const beforeAttack = serviceCallsSince(stderr);
        const healthy = await sendRaw({
            port: ready.port,
            method: "GET",
            target: "/api/state",
            host,
            headers: { "x-storage-inspector-token": ready.token },
        });
        assert.equal(healthy.status, 200);
        assert.equal(healthy.json.scan.status, "idle");
        assert.ok(serviceCallsSince(stderr).includes("getState"));

        const callsBeforeInvalid = serviceCallsSince(stderr).length;
        for (const target of invalidRequestTargets) {
            for (const method of target === "//" ? methods : ["GET"]) {
                const response = await requestOrCrash(child, () => stderr, { port: ready.port, method, target, host });
                assert.equal(response.status, 400, `${method} ${JSON.stringify(target)} status`);
                if (method !== "HEAD") {
                    assert.equal(response.json.code !== undefined, true, `${method} ${JSON.stringify(target)} JSON code`);
                    assert.equal(typeof response.json.message, "string");
                    assert.equal(response.json.message.length > 0, true);
                    assert.match(response.headers["content-type"] ?? "", /application\/json/);
                }
                assert.equal(
                    serviceCallsSince(stderr).length,
                    callsBeforeInvalid,
                    `${method} ${JSON.stringify(target)} invoked the storage service before refusing`,
                );
            }
        }

        const withToken = await requestOrCrash(child, () => stderr, {
            port: ready.port,
            method: "POST",
            target: "http://",
            host,
            headers: { "x-storage-inspector-token": ready.token },
        });
        assert.equal(withToken.status, 400);
        assert.equal(
            serviceCallsSince(stderr).length,
            callsBeforeInvalid,
            "an authorized invalid target invoked the storage service",
        );

        const after = await sendRaw({
            port: ready.port,
            method: "GET",
            target: "/api/state",
            host,
            headers: { "x-storage-inspector-token": ready.token },
        });
        assert.equal(after.status, 200, "server kept serving after invalid request-targets");
        assert.equal(after.json.scan.status, "idle");
        assert.ok(serviceCallsSince(stderr).filter((name) => name === "getState").length >= 2);
        assert.equal(child.exitCode, null);
        assert.ok(beforeAttack.includes("subscribe"));
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                child.kill("SIGTERM");
            } catch {
                // The child already exited from the unhandled rejection.
            }
        }
        if (child.exitCode === null && child.signalCode === null) {
            await new Promise((resolve) => child.once("exit", resolve));
        }
    }
}

function serviceCallsSince(stderr) {
    return stderr.split("\n")
        .filter((line) => line.startsWith("SERVICE_CALL "))
        .map((line) => line.slice("SERVICE_CALL ".length));
}

async function requestOrCrash(child, readStderr, options) {
    try {
        const response = await sendRaw(options);
        if (child.exitCode !== null) {
            throw new Error(`process exited with ${child.exitCode}`);
        }
        return response;
    } catch (error) {
        await new Promise((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }
            const timer = setTimeout(resolve, 200);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
        throw new Error(
            `${options.method} ${JSON.stringify(options.target)} did not return a handled response `
            + `(process exit ${child.exitCode}).\n${readStderr()}\n${error.message}`,
        );
    }
}

function sendRaw({ port, method, target, host, headers = {} }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        const chunks = [];
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`timed out waiting for ${method} ${JSON.stringify(target)}`));
        }, 2000);
        const fail = (error) => {
            clearTimeout(timer);
            reject(error);
        };
        socket.on("error", fail);
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("connect", () => {
            const lines = [
                `${method} ${target} HTTP/1.1`,
                `Host: ${host}`,
                "Connection: close",
                ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
                "",
                "",
            ];
            socket.end(lines.join("\r\n"));
        });
        socket.on("end", () => {
            clearTimeout(timer);
            try {
                resolve(parseResponse(Buffer.concat(chunks), method, target));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function parseResponse(buffer, method, target) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
        throw new Error(`no complete response for ${method} ${JSON.stringify(target)} (${buffer.length} bytes)`);
    }
    const headerText = buffer.toString("latin1", 0, headerEnd);
    const [statusLine, ...headerLines] = headerText.split("\r\n");
    const status = Number(statusLine.split(" ")[1]);
    const headers = {};
    for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator > 0) {
            headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
        }
    }
    let body = buffer.subarray(headerEnd + 4);
    if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
        body = decodeChunked(body);
    } else if (headers["content-length"]) {
        body = body.subarray(0, Number(headers["content-length"]));
    }
    const response = { status, headers, body };
    if (method !== "HEAD" && (headers["content-type"] ?? "").includes("application/json")) {
        response.json = JSON.parse(body.toString("utf8"));
    } else if (method !== "HEAD" && status !== 400) {
        response.json = body.length ? JSON.parse(body.toString("utf8")) : {};
    } else if (method !== "HEAD") {
        response.json = JSON.parse(body.toString("utf8"));
    }
    return response;
}

function decodeChunked(buffer) {
    const parts = [];
    let offset = 0;
    while (offset < buffer.length) {
        const lineEnd = buffer.indexOf("\r\n", offset);
        if (lineEnd < 0) {
            break;
        }
        const size = Number.parseInt(buffer.toString("ascii", offset, lineEnd), 16);
        if (!Number.isFinite(size)) {
            break;
        }
        offset = lineEnd + 2;
        if (size === 0) {
            break;
        }
        parts.push(buffer.subarray(offset, offset + size));
        offset += size + 2;
    }
    return Buffer.concat(parts);
}
