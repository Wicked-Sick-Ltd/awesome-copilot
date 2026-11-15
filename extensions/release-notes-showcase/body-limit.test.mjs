// Spec for the release-notes loopback body cap.
//
// Opening the canvas (the same open() the SDK calls for a canvas.open RPC)
// binds an HTTP server to 127.0.0.1. POST /actions/export-email and
// POST /actions/load-release are the only routes that read a body. Both go
// through readJsonBody, which appends every chunk with no limit. These tests
// fail while that is true and pass once each of those routes:
//   - still serves the small JSON the canvas posts, with no token and no
//     pinned Host value
//   - accepts a body up to 64 KiB
//   - answers 413 and destroys the socket once more than 64 KiB has arrived,
//     before the client finishes the body and before JSON.parse
//
// POST paths that do not read a body are not covered. The handler returns
// 404 for those without buffering.
//
// Run from the repository root:
//   node --test extensions/release-notes-showcase/body-limit.test.mjs

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { releaseNotesShowcaseCanvas } from "./releaseNotesShowcase.mjs";

// Largest body the loopback API may buffer. The canvas posts a few dozen bytes.
const MAX_BODY_BYTES = 64 * 1024;
// Chunk size used when streaming. The cap may trip one chunk late.
const CHUNK_BYTES = 8 * 1024;
// Bytes the client may have queued when the server destroys the socket.
const SLACK_BYTES = CHUNK_BYTES * 4;
const CEILING_BYTES = MAX_BODY_BYTES + 1024 * 1024;

const POST_ROUTES = ["/actions/export-email", "/actions/load-release"];

describe("release notes loopback POST body limit", { concurrency: 1 }, () => {
    test("canvas open binds 127.0.0.1 and both small POSTs succeed without a token", async (t) => {
        const canvas = await openCanvas(t);
        const page = await request(canvas.port, { method: "GET", path: "/" });
        assert.equal(page.status, 200);
        assert.match(page.text, /<html/i);

        const exported = await request(canvas.port, {
            method: "POST",
            path: "/actions/export-email",
            body: JSON.stringify({ format: "text" }),
            headers: spoofedHeaders(),
        });
        assert.equal(exported.status, 200, exported.text);
        assert.equal(typeof exported.json?.text, "string");
        assert.ok(exported.json.text.length > 0);

        const loaded = await request(canvas.port, {
            method: "POST",
            path: "/actions/load-release",
            body: JSON.stringify({ mode: "unreleased", tag: "" }),
            headers: spoofedHeaders(),
        });
        assert.equal(loaded.status, 200, loaded.text);
        assert.equal(typeof loaded.json?.title, "string");
    });

    for (const path of POST_ROUTES) {
        test(`POST ${path} accepts a 32 KiB JSON body`, async (t) => {
            const canvas = await openCanvas(t);
            const payload = paddedJson(path);
            assert.ok(Buffer.byteLength(payload) > 32 * 1024);
            assert.ok(Buffer.byteLength(payload) <= MAX_BODY_BYTES);

            const response = await request(canvas.port, {
                method: "POST",
                path,
                body: payload,
                headers: spoofedHeaders(),
            });
            assert.equal(response.status, 200, response.text);
        });

        test(`POST ${path} returns 413 and destroys the socket before the body is finished`, async (t) => {
            const canvas = await openCanvas(t);
            const outcome = await streamUntilRejected(canvas.port, path);

            assert.equal(
                outcome.status,
                413,
                `expected 413 before the body finished; status=${outcome.status} written=${outcome.written} destroyed=${outcome.destroyed}`,
            );
            assert.ok(
                outcome.written <= MAX_BODY_BYTES + SLACK_BYTES,
                `server kept reading past ${MAX_BODY_BYTES} bytes (accepted ${outcome.written})`,
            );
            assert.equal(
                outcome.destroyed,
                true,
                "the request socket must be destroyed once the cap is passed, not left open to buffer the rest",
            );
            assert.equal(
                outcome.clientEnded,
                false,
                "413 must arrive before the client finishes the body",
            );
        });
    }
});

function spoofedHeaders(extra = {}) {
    return {
        Host: "not-a-pinned-host.example",
        "Content-Type": "application/json",
        ...extra,
    };
}

function paddedJson(path) {
    const pad = "n".repeat(32 * 1024);
    if (path === "/actions/export-email") {
        return JSON.stringify({ format: "text", pad });
    }
    return JSON.stringify({ mode: "unreleased", tag: "", pad });
}

async function openCanvas(t) {
    const repo = await mkdtemp(join(tmpdir(), "release-notes-body-"));
    const git = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const instanceId = `body-limit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const opened = await releaseNotesShowcaseCanvas.open({
        instanceId,
        canvasId: "release-notes-showcase",
        input: {},
        session: { workingDirectory: repo },
        sessionId: instanceId,
    });
    t.after(async () => {
        await releaseNotesShowcaseCanvas.onClose({ instanceId });
        await rm(repo, { recursive: true, force: true });
    });
    const url = new URL(opened.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) > 0);
    return { port: Number(url.port), url };
}

function request(port, { method, path, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                method,
                path,
                agent: false,
                headers: {
                    ...headers,
                    ...(body !== undefined ? { "Content-Length": Buffer.byteLength(body) } : {}),
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = null;
                    }
                    resolve({ status: res.statusCode, text, json });
                });
            },
        );
        req.setTimeout(10000, () => req.destroy(new Error(`${method} ${path} timed out`)));
        req.on("error", reject);
        req.end(body);
    });
}

// Streams an unbounded chunked body and stops once the server responds or the
// client has already handed over far more than the cap. Never calls req.end(),
// so a handler that buffers until 'end' and only then returns 413 fails.
async function streamUntilRejected(port, path) {
    const chunk = Buffer.alloc(CHUNK_BYTES, 0x61);
    const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        agent: false,
        headers: spoofedHeaders(),
    });
    let written = 0;
    let status = null;
    let settled = false;
    let socketError = null;

    req.on("response", (res) => {
        status = res.statusCode;
        res.resume();
    });
    req.on("error", (err) => {
        socketError = err;
        settled = true;
    });

    while (!settled && status === null && written < CEILING_BYTES) {
        let ok = false;
        try {
            ok = req.write(chunk);
        } catch (err) {
            socketError = err;
            settled = true;
            break;
        }
        written += chunk.length;
        if (!ok) {
            await Promise.race([
                once(req, "drain").catch(() => {}),
                once(req, "error").catch(() => {}),
                wait(500),
            ]);
        } else {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    if (status === null && !settled) {
        await Promise.race([once(req, "response").catch(() => {}), wait(300)]);
    }
    await wait(50);

    const destroyed = Boolean(req.destroyed || req.socket?.destroyed || socketError);
    const snapshot = {
        status,
        written,
        destroyed,
        clientEnded: false,
        error: socketError ? socketError.code || socketError.message : null,
    };
    req.destroy();
    return snapshot;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
