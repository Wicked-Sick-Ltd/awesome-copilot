// Spec for the Gesture Review loopback server in extension.mjs.
//
// POST /select-pr and POST /gesture-decision append every request chunk into
// one string and never stop the socket. These tests fail while that is true.
// They pass once each handler stops reading and destroys the request when the
// body grows past a small limit of at most 1 MiB, and only then parses what
// it kept. A short JSON body with no capability token must still succeed.
//
// Run from the repository root:
//   node --expose-gc --test extensions/gesture-review/body-limit.test.mjs

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { registerHooks } from "node:module";
import net from "node:net";
import test from "node:test";

const ONE_MIB = 1024 * 1024;
// Other canvases cap the body at 1 MiB. Anything past that must be refused.
const MAX_BODY_BYTES = ONE_MIB;
// Heap growth allowed after a multi-megabyte upload: the 1 MiB cap plus slack
// for the chunk that crossed it. Retention of the whole upload is several times this.
const MAX_RETAINED_BYTES = ONE_MIB + 256 * 1024;
const OVERSIZED_BYTES = 4 * ONE_MIB;
const CHUNK_BYTES = 64 * 1024;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@github/copilot-sdk/extension") {
			return {
				shortCircuit: true,
				url: new URL("./test/copilot-sdk-stub.mjs", import.meta.url).href,
			};
		}
		return nextResolve(specifier, context);
	},
});

const listened = [];
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function listenAndRecord(...args) {
	listened.push(this);
	return originalListen.apply(this, args);
};

await import("./extension.mjs");

const server = listened[0];
assert.ok(server, "gesture-review extension did not start its HTTP server");
const bound = server.address();
assert.equal(bound.address, "127.0.0.1");
const port = bound.port;

test.after(async () => {
	server.closeAllConnections?.();
	if (server.listening) {
		await new Promise((resolve) => server.close(() => resolve()));
	}
});

function heapUsed() {
	assert.equal(typeof global.gc, "function", "re-run with node --expose-gc");
	global.gc();
	return process.memoryUsage().heapUsed;
}

function postJson(path, payload) {
	const body = Buffer.from(payload);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				agent: false,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(body.length),
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					resolve({
						status: res.statusCode,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		req.on("error", (err) => {
			resolve({ status: null, body: "", error: err.code || err.message });
		});
		req.setTimeout(5000, () => req.destroy(new Error("timeout")));
		req.end(body);
	});
}

// Chunked POST with no Content-Length. Resolves after the server stops the
// socket or after `total` body bytes have been written, whichever comes first.
// The caller does not end the request.
async function streamOpenBody(path, total) {
	const socket = net.connect({ host: "127.0.0.1", port });
	socket.on("error", () => {});
	let response = "";
	socket.on("data", (chunk) => {
		if (response.length < 1024) response += chunk.toString("utf8");
	});
	await once(socket, "connect");
	socket.write(
		`POST ${path} HTTP/1.1\r\n` +
			`Host: 127.0.0.1:${port}\r\n` +
			`Transfer-Encoding: chunked\r\n` +
			`\r\n`,
	);

	const payload = Buffer.alloc(CHUNK_BYTES, 0x61);
	const tail = Buffer.from("\r\n");
	// Drop any string retained by an earlier request so this baseline is empty.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const baseline = heapUsed();
	let sent = 0;
	let peak = baseline;
	let stopped = socket.destroyed;

	const note = () => {
		const used = heapUsed();
		if (used > peak) peak = used;
	};

	while (sent < total && !socket.destroyed) {
		const n = Math.min(CHUNK_BYTES, total - sent);
		const header = Buffer.from(`${n.toString(16)}\r\n`);
		const body = n === CHUNK_BYTES ? payload : payload.subarray(0, n);
		const headerOk = socket.write(header);
		const bodyOk = socket.write(body);
		const tailOk = socket.write(tail);
		sent += n;
		if ((!headerOk || !bodyOk || !tailOk) && !socket.destroyed) {
			await Promise.race([
				once(socket, "drain"),
				once(socket, "close"),
				once(socket, "error"),
			]).catch(() => {});
		}
		// Let the request handler append this chunk before sampling the heap.
		await new Promise((resolve) => setImmediate(resolve));
		if (socket.destroyed) {
			stopped = true;
			break;
		}
		if (sent % (256 * 1024) === 0) note();
		if (socket.destroyed) {
			stopped = true;
			break;
		}
	}

	// Give a handler that destroys on the next tick a moment to do it.
	await new Promise((resolve) => setTimeout(resolve, 150));
	note();
	stopped = stopped || socket.destroyed;
	const status = /^HTTP\/1\.[01] (\d+)/.exec(response)?.[1] ?? null;
	if (!socket.destroyed) socket.destroy();
	return {
		sent,
		stopped,
		status: status === null ? null : Number(status),
		growth: peak - baseline,
		response: response.slice(0, 180),
	};
}

function assertBodyWasCapped(path, result) {
	const refused = result.stopped || result.status === 413;
	const bounded = result.growth < MAX_RETAINED_BYTES;
	assert.ok(
		refused && bounded,
		`${path} kept reading an unbounded body ` +
			`(sent=${result.sent}, stopped=${result.stopped}, status=${result.status}, ` +
			`heapGrowth=${result.growth}, response=${JSON.stringify(result.response)})`,
	);
	assert.ok(
		result.sent > MAX_BODY_BYTES || result.stopped,
		`${path} stopped before the body could exceed ${MAX_BODY_BYTES} bytes`,
	);
}

test("gesture-review POST body limits", { concurrency: false }, async (t) => {
	await t.test("small unauthenticated posts still succeed", async () => {
		const selected = await postJson("/select-pr", JSON.stringify({ number: 1 }));
		assert.equal(selected.status, 200, selected.body);
		assert.equal(JSON.parse(selected.body).ok, true);

		const decided = await postJson("/gesture-decision", JSON.stringify({ decision: "approved" }));
		assert.equal(decided.status, 200, decided.body);
		assert.deepEqual(JSON.parse(decided.body), { ok: true, decision: "approved" });
	});

	await t.test("open POST /select-pr body is capped and not retained", async () => {
		const result = await streamOpenBody("/select-pr", OVERSIZED_BYTES);
		assertBodyWasCapped("/select-pr", result);
	});

	await t.test("open POST /gesture-decision body is capped and not retained", async () => {
		const result = await streamOpenBody("/gesture-decision", OVERSIZED_BYTES);
		assertBodyWasCapped("/gesture-decision", result);
	});

	await t.test("a finished body over 1 MiB is not applied", async () => {
		const pad = "a".repeat(MAX_BODY_BYTES + 4096);
		const routes = [
			["/select-pr", JSON.stringify({ number: 1, pad })],
			["/gesture-decision", JSON.stringify({ decision: "approved", pad })],
		];
	const failures = [];
	for (const [path, payload] of routes) {
		assert.ok(Buffer.byteLength(payload) > MAX_BODY_BYTES);
		const result = await postJson(path, payload);
		const applied = result.status === 200 && result.body.includes('"ok":true');
		if (applied || (result.status !== 413 && result.status !== null)) {
			failures.push(
				`${path} accepted a ${Buffer.byteLength(payload)}-byte body (status=${result.status}, error=${result.error || ""}, body=${result.body.slice(0, 180)})`,
			);
		}
	}
	assert.deepEqual(failures, []);
	});

	await t.test("the canvas server still answers after an oversized post", async () => {
		const selected = await postJson("/select-pr", JSON.stringify({ number: 2 }));
		assert.equal(selected.status, 200, selected.error || selected.body);
		assert.equal(JSON.parse(selected.body).ok, true);
	});
});
