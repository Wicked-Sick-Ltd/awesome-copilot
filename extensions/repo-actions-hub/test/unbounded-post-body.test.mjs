// Spec for the Repo Actions Hub loopback body limit.
//
// POST /api/run feeds every socket chunk to readJsonBody, which appends
// chunk.toString() with no maximum and does not destroy the socket. These
// tests fail while that remains true. They pass once a body over 64 KiB is
// refused and the socket is destroyed before the client finishes sending,
// including when Content-Length is huge or absent (chunked encoding).
//
// Routes that do not share this read are not asserted here:
//   GET /, GET /api/state, POST /api/refresh, GET /api/workflow,
//   GET /api/run-details, GET /events.
// None of those call readJsonBody. Unread request streams stay at the
// IncomingMessage high-water mark instead of being concatenated.
//
// Run from extensions/repo-actions-hub:
//   node --expose-gc --import ./test/register-sdk-stub.mjs --test ./test/unbounded-post-body.test.mjs

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { captured } from "./sdk-stub.mjs";
import "../extension.mjs";

const LIMIT = 64 * 1024;
const CHUNK = 8 * 1024;
const SLACK = 32 * 1024;
const DECLARED_LENGTH = 8 * 1024 * 1024;

const binDir = path.join(tmpdir(), "repo-actions-hub-body-limit-gh");
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

let port;
let canvas;

describe("repo-actions-hub POST /api/run body limit", { concurrency: false }, () => {

before(async () => {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(
        ghPath,
        [
            "#!/bin/sh",
            "args=\"$*\"",
            "case \"$args\" in",
            "    *\"repo view\"*)",
            "        printf '%s\\n' '{\"nameWithOwner\":\"octo/demo\",\"defaultBranchRef\":{\"name\":\"main\"},\"url\":\"https://example.test/octo/demo\"}'",
            "        ;;",
            "    *\"workflow list\"*)",
            "        printf '%s\\n' '[]'",
            "        ;;",
            "    *\"run list\"*)",
            "        printf '%s\\n' '[]'",
            "        ;;",
            "    *)",
            "        echo \"unexpected gh invocation: $args\" >&2",
            "        exit 1",
            "        ;;",
            "esac",
            "",
        ].join("\n"),
        "utf8"
    );
    await chmod(ghPath, 0o755);

    canvas = captured.config?.canvases?.[0];
    assert.ok(canvas?.open, "extension did not register the repo-actions-hub canvas");
    const opened = await canvas.open({
        instanceId: "body-limit",
        input: { repo: "octo/demo" },
    });
    const url = new URL(opened.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.search, "", "canvas URL is not pinned to a capability token");
    port = Number(url.port);
    assert.ok(port > 0);

    const home = await fetch(opened.url);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /Repo Actions Hub/);
});

after(async () => {
    if (canvas?.onClose) {
        await canvas.onClose({ instanceId: "body-limit" });
    }
});

test("POST /api/run still parses a JSON body under 64 KiB", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Host: `127.0.0.1:${port}`,
        },
        body: JSON.stringify({ workflowId: "missing" }),
    });
    const payload = await response.json();
    assert.notEqual(response.status, 413);
    assert.equal(response.status, 500);
    assert.match(payload.error, /was not found/);
});

test("POST /api/run still parses an invalid JSON body under 64 KiB", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Host: `127.0.0.1:${port}`,
        },
        body: "x".repeat(100),
    });
    const payload = await response.json();
    assert.notEqual(response.status, 413);
    assert.match(payload.error, /valid JSON/);
});

test("chunked POST /api/run over 64 KiB is destroyed before the body ends", async () => {
    const result = await streamOversized({ chunked: true });
    assertRejectedEarly(result, "chunked");
});

test("POST /api/run with a multi-megabyte Content-Length is destroyed before that body is read", async () => {
    const result = await streamOversized({ chunked: false, contentLength: DECLARED_LENGTH });
    assertRejectedEarly(result, "content-length");
});

test("POST /api/run destroys the socket when the first chunk alone exceeds 64 KiB", async () => {
    const result = await streamOversized({
        chunked: true,
        chunkSize: LIMIT + CHUNK,
        // One oversized chunk crosses the limit immediately. A fix that appends
        // the chunk and then destroys still passes; a fix that keeps reading
        // the rest of an open chunked body does not.
        stopAfter: LIMIT + CHUNK,
    });
    assertRejectedEarly(result, "single-chunk");
});

});

function assertRejectedEarly(result, label) {
    assert.equal(
        result.stopped,
        true,
        `${label}: POST /api/run was still open after ${result.sent} bytes ` +
            `(serverBytesRead=${result.serverBytesRead}, status=${result.status ?? "none"}, ` +
            `error=${result.errorCode ?? "none"}, heapDelta=${result.heapDelta ?? "n/a"}). ` +
            `The server must destroy the socket once the body exceeds ${LIMIT} bytes, ` +
            `without waiting for the rest of the body. Response head: ${JSON.stringify(result.head)}`
    );
    assert.ok(
        result.sent <= LIMIT + SLACK,
        `${label}: server accepted ${result.sent} bytes before stopping; limit is ${LIMIT} bytes`
    );
    assert.ok(
        result.serverBytesRead > 0 && result.serverBytesRead <= LIMIT + SLACK + 1024,
        `${label}: server socket read ${result.serverBytesRead} bytes; it must stop at ${LIMIT} bytes`
    );
    if (result.heapDelta != null && typeof global.gc === "function") {
        assert.ok(
            result.heapDelta < 256 * 1024,
            `${label}: heap grew by ${result.heapDelta} bytes while the oversized body was refused`
        );
    }
}

function peerBytesRead(client) {
    let best = 0;
    for (const handle of process._getActiveHandles()) {
        if (!handle || handle === client || typeof handle.bytesRead !== "number") {
            continue;
        }
        if (handle.remotePort === client.localPort) {
            best = Math.max(best, handle.bytesRead);
        }
    }
    return best;
}

function streamOversized({ chunked, contentLength = DECLARED_LENGTH, chunkSize = CHUNK, stopAfter = LIMIT }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.setNoDelay(true);
        global.gc?.();
        const started = process.memoryUsage().heapUsed;
        let received = Buffer.alloc(0);
        let sent = 0;
        let stopped = false;
        let errorCode = null;
        let settled = false;

        const finish = (heapDelta = null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(overall);
            const serverBytesRead = peerBytesRead(socket);
            socket.removeAllListeners("data");
            try {
                socket.destroy();
            } catch {
                // already closed
            }
            const head = received.toString("latin1", 0, 180);
            const status = /^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? null;
            resolve({ sent, stopped, status, errorCode, heapDelta, head, serverBytesRead });
        };

        const overall = setTimeout(() => finish(measureHeap(started)), 8000);

        socket.on("data", (chunk) => {
            received = Buffer.concat([received, chunk]);
        });
        socket.on("error", (error) => {
            errorCode = error.code ?? error.message;
            stopped = true;
        });
        socket.on("close", () => {
            stopped = true;
            finish(measureHeap(started));
        });

        socket.on("connect", async () => {
            try {
                const header = [
                    "POST /api/run HTTP/1.1",
                    `Host: 127.0.0.1:${port}`,
                    "Content-Type: application/json",
                    chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${contentLength}`,
                    "Connection: close",
                    "",
                    "",
                ].join("\r\n");
                socket.write(header);

                while (sent <= stopAfter && !stopped && !socket.destroyed) {
                    const size = Math.min(chunkSize, Math.max(CHUNK, stopAfter + CHUNK - sent));
                    if (!writeBody(socket, size, chunked)) {
                        stopped = true;
                        break;
                    }
                    sent += size;
                    await delay(15);
                }

                const deadline = Date.now() + 1000;
                while (Date.now() < deadline && !stopped && !socket.destroyed) {
                    await delay(20);
                }

                if (stopped || socket.destroyed) {
                    stopped = true;
                    finish(measureHeap(started));
                    return;
                }

                // Still open after the limit: push another 512 KiB. A fix has to
                // have stopped already; this remainder is what an unbounded
                // reader will keep appending to the in-memory body.
                const extraGoal = sent + 512 * 1024;
                while (sent < extraGoal && !stopped && !socket.destroyed) {
                    const size = 64 * 1024;
                    if (!writeBody(socket, size, chunked)) {
                        stopped = true;
                        break;
                    }
                    sent += size;
                    await delay(5);
                }
                await delay(30);
                finish(measureHeap(started));
            } catch (error) {
                if (!settled) {
                    settled = true;
                    clearTimeout(overall);
                    reject(error);
                }
            }
        });
    });
}

function writeBody(socket, size, chunked) {
    if (socket.destroyed || !socket.writable) {
        return false;
    }
    const payload = Buffer.alloc(size, 0x61);
    try {
        if (!chunked) {
            socket.write(payload);
        } else {
            socket.write(Buffer.concat([
                Buffer.from(`${size.toString(16)}\r\n`),
                payload,
                Buffer.from("\r\n"),
            ]));
        }
        return !socket.destroyed;
    } catch {
        return false;
    }
}

function measureHeap(started) {
    global.gc?.();
    return process.memoryUsage().heapUsed - started;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
