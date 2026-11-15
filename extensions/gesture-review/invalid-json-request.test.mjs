import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const rpc = require("vscode-jsonrpc/node");
const extensionDir = fileURLToPath(new URL(".", import.meta.url));

// Bodies that throw inside the POST end listeners. "{" and "" make JSON.parse
// throw. "null" parses, then destructuring throws. Other JSON primitives do
// not throw. Each throwing body must get HTTP 400, and the process must stay up.
const rejectingBodies = ["{", "", "null"];

function listeningPorts(pid) {
	const inodes = new Set();
	let fds;
	try {
		fds = readdirSync(`/proc/${pid}/fd`);
	} catch {
		return [];
	}
	for (const fd of fds) {
		try {
			const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
			const match = /socket:\[(\d+)\]/.exec(link);
			if (match) inodes.add(match[1]);
		} catch {
			// fd closed between readdir and readlink
		}
	}
	let text;
	try {
		text = readFileSync(`/proc/${pid}/net/tcp`, "utf8");
	} catch {
		return [];
	}
	const ports = [];
	for (const line of text.split("\n").slice(1)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 10 || parts[3] !== "0A" || !inodes.has(parts[9])) continue;
		const [ip, portHex] = parts[1].split(":");
		if (ip !== "0100007F") continue;
		ports.push(Number.parseInt(portHex, 16));
	}
	return ports;
}

function startExtension() {
	const child = spawn(process.execPath, ["extension.mjs"], {
		cwd: extensionDir,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, SESSION_ID: "gesture-review-test" },
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	let resumed = false;
	const connection = rpc.createMessageConnection(
		new rpc.StreamMessageReader(child.stdout),
		new rpc.StreamMessageWriter(child.stdin),
	);
	connection.onError(() => {});
	connection.onClose(() => {});
	connection.onRequest((method) => {
		if (method === "connect") return { protocolVersion: 3 };
		if (method === "session.resume") {
			resumed = true;
			return { workspacePath: extensionDir, capabilities: {}, openCanvases: [] };
		}
		return {};
	});
	connection.listen();

	return {
		child,
		stderr: () => stderr,
		async ready() {
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				if (child.exitCode !== null) {
					throw new Error(
						`extension exited ${child.exitCode} before listening\n${stderr}`,
					);
				}
				const ports = listeningPorts(child.pid);
				if (resumed && ports.length === 1) return ports[0];
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error(`extension did not stay listening\n${stderr}`);
		},
		stop() {
			connection.dispose();
			child.kill();
		},
	};
}

function exitCodeOf(child) {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(child.exitCode), 300);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

function post(port, path, body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					Connection: "close",
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
		req.on("error", reject);
		req.setTimeout(2000, () => req.destroy(new Error("timeout")));
		req.end(body);
	});
}

function snapshot(port) {
	return new Promise((resolve, reject) => {
		const req = http.get(
			{ host: "127.0.0.1", port, path: "/events", headers: { Accept: "text/event-stream" } },
			(res) => {
				let buf = "";
				const events = [];
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					buf += chunk;
					let splitAt;
					while ((splitAt = buf.indexOf("\n\n")) !== -1) {
						const raw = buf.slice(0, splitAt);
						buf = buf.slice(splitAt + 2);
						const event = { event: "message", data: "" };
						for (const line of raw.split("\n")) {
							if (line.startsWith("event:")) event.event = line.slice(6).trim();
							else if (line.startsWith("data:")) event.data += line.slice(5).trim();
						}
						if (raw.trim()) events.push(event);
					}
				});
				setTimeout(() => {
					req.destroy();
					resolve({ status: res.statusCode, events });
				}, 200);
			},
		);
		req.on("error", (error) => {
			if (error.code === "ECONNRESET") resolve({ status: null, events: [] });
			else reject(error);
		});
	});
}

async function expectBadBodyRejected(path, body) {
	const server = startExtension();
	try {
		const port = await server.ready();
		let response;
		try {
			response = await post(port, path, body);
		} catch (error) {
			const exitCode = await exitCodeOf(server.child);
			assert.fail(
				`POST ${path} body ${JSON.stringify(body)} did not return a response ` +
					`(${error.code || error.message}); process exit=${exitCode}\n` +
					server.stderr(),
			);
		}
		assert.equal(
			response.status,
			400,
			`POST ${path} body ${JSON.stringify(body)} status ${response.status} body ${response.body}`,
		);
		assert.equal(await exitCodeOf(server.child), null, server.stderr());

		const state = await snapshot(port);
		assert.equal(state.status, 200);
		const gesture = state.events.find((event) => event.event === "state");
		assert.ok(gesture, "state event missing");
		assert.deepEqual(JSON.parse(gesture.data), { state: "idle" });
		assert.equal(
			state.events.some((event) => event.event === "pr"),
			false,
			"invalid body selected a pull request",
		);

		const followUpPath = path === "/select-pr" ? "/gesture-decision" : "/select-pr";
		const followUpBody = path === "/select-pr" ? '{"decision":"approved"}' : '{"number":1}';
		const followUp = await post(port, followUpPath, followUpBody);
		assert.equal(followUp.status, 200, followUp.body);
		assert.equal(await exitCodeOf(server.child), null, server.stderr());
	} finally {
		server.stop();
	}
}

for (const path of ["/select-pr", "/gesture-decision"]) {
	for (const body of rejectingBodies) {
		test(`POST ${path} rejects ${JSON.stringify(body)} with 400 and stays up`, async () => {
			await expectBadBodyRejected(path, body);
		});
	}
}

test("well-formed JSON objects are still accepted on both POST routes", async () => {
	const server = startExtension();
	try {
		const port = await server.ready();
		const selected = await post(port, "/select-pr", '{"number":1}');
		assert.equal(selected.status, 200, selected.body);
		assert.equal(JSON.parse(selected.body).ok, true);
		const decision = await post(port, "/gesture-decision", '{"decision":"approved"}');
		assert.equal(decision.status, 200, decision.body);
		assert.equal(JSON.parse(decision.body).ok, true);
		assert.equal(server.child.exitCode, null);
	} finally {
		server.stop();
	}
});
