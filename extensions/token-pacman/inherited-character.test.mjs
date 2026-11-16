// Run: node --test extensions/token-pacman/inherited-character.test.mjs
//
// The open canvas listens on 127.0.0.1 with no capability token. These tests
// drive that server, then the page it serves, and fail while an inherited
// character name can be stored and later painted.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHooks } from "node:module";
import { test } from "node:test";

const OWN = [
    { name: "Mr. Pac-Man", color: "#ffd43b" },
    { name: "Mrs. Pac-Man", color: "#ff78b7" },
];

const INHERITED_NAMES = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__lookupGetter__",
    "__defineSetter__",
    "__lookupSetter__",
    "__proto__",
];

const CHROME = "/opt/google/chrome/chrome";

let canvasPromise;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCanvas() {
    canvasPromise ??= (async () => {
        const mock = `
            export function createCanvas(definition) {
                globalThis.__tokenPacmanTestCanvas = definition;
                return definition;
            }
            export async function joinSession() {
                return {
                    rpc: { usage: { async getMetrics() { return { totalNanoAiu: 0, totalPremiumRequestCost: 0 }; } } },
                    connection: { async sendRequest() { return { quotaSnapshots: {} }; } },
                    async log() {},
                    on() {},
                };
            }
        `;
        registerHooks({
            resolve(specifier, context, nextResolve) {
                if (specifier === "@github/copilot-sdk/extension") {
                    return { url: `data:text/javascript,${encodeURIComponent(mock)}`, shortCircuit: true };
                }
                return nextResolve(specifier, context);
            },
        });
        await import("./extension.mjs");
        return globalThis.__tokenPacmanTestCanvas;
    })();
    return canvasPromise;
}

function ownCharacterError(snapshot) {
    const character = snapshot?.character;
    if (!character || typeof character !== "object") {
        return `character is missing from ${JSON.stringify(snapshot)}`;
    }
    const match = OWN.find((item) => item.name === character.name && item.color === character.color);
    if (!match) return `character is not an own record: ${JSON.stringify(character)}`;
    let serialized;
    try {
        serialized = JSON.parse(JSON.stringify(snapshot));
    } catch (error) {
        return `snapshot did not serialize: ${error.message}`;
    }
    if (serialized.character?.name !== character.name || serialized.character?.color !== character.color) {
        return "character did not survive JSON serialization";
    }
    return null;
}

function request(url, { method = "GET", path: requestPath = null, headers = {}, body = null } = {}) {
    const target = new URL(url);
    const payload = body == null ? null : Buffer.from(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: requestPath ?? `${target.pathname}${target.search}`,
            method,
            agent: false,
            headers: {
                Connection: "close",
                ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try {
                    json = raw ? JSON.parse(raw) : null;
                } catch {
                    json = null;
                }
                resolve({ status: res.statusCode, raw, json });
            });
        });
        req.on("error", reject);
        req.end(payload ?? undefined);
    });
}

function decodeBody(rawBody, headers) {
    if (!/chunked/i.test(headers)) return rawBody;
    let rest = rawBody;
    let decoded = "";
    while (rest.length) {
        const lineEnd = rest.indexOf("\r\n");
        if (lineEnd < 0) return rawBody;
        const size = Number.parseInt(rest.slice(0, lineEnd), 16);
        if (!Number.isInteger(size)) return rawBody;
        if (size === 0) return decoded;
        const start = lineEnd + 2;
        decoded += rest.slice(start, start + size);
        rest = rest.slice(start + size + 2);
    }
    return decoded;
}

function rawPost(url, { host, path: requestPath, headers = {}, body }) {
    const target = new URL(url);
    const payload = Buffer.from(body);
    const head = [
        `POST ${requestPath} HTTP/1.1`,
        `Host: ${host}`,
        "Connection: close",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        `Content-Length: ${payload.length}`,
        "",
        "",
    ].join("\r\n");
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(target.port), target.hostname, () => {
            socket.write(head);
            socket.write(payload);
        });
        const chunks = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", reject);
        socket.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const splitAt = raw.indexOf("\r\n\r\n");
            const head = splitAt >= 0 ? raw.slice(0, splitAt) : raw;
            const status = Number(head.split("\r\n")[0].split(" ")[1]);
            const rawBody = decodeBody(splitAt >= 0 ? raw.slice(splitAt + 4) : "", head);
            let json = null;
            try {
                json = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                json = null;
            }
            resolve({ status, rawBody, json });
        });
    });
}

function openEvents(url) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: "/events",
            method: "GET",
            agent: false,
            headers: { Accept: "text/event-stream", Connection: "close" },
        }, (res) => {
            let buffer = "";
            const events = [];
            res.on("data", (chunk) => {
                buffer += chunk.toString("utf8");
                let splitAt = buffer.indexOf("\n\n");
                while (splitAt >= 0) {
                    const block = buffer.slice(0, splitAt);
                    buffer = buffer.slice(splitAt + 2);
                    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
                    if (data) events.push(JSON.parse(data));
                    splitAt = buffer.indexOf("\n\n");
                }
            });
            resolve({
                status: res.statusCode,
                events,
                close() {
                    req.destroy();
                    res.destroy();
                },
            });
        });
        req.on("error", reject);
        req.end();
    });
}

async function waitForCount(events, count) {
    const deadline = Date.now() + 2000;
    while (events.length < count && Date.now() < deadline) await delay(20);
    return events.length >= count;
}

async function closeInstance(canvas, instanceId, stream) {
    stream?.close();
    await Promise.race([
        canvas.onClose({ instanceId }),
        delay(2000),
    ]);
}

async function launchChrome() {
    const dir = await mkdtemp(path.join(tmpdir(), "token-pacman-chrome-"));
    const child = spawn(CHROME, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--remote-debugging-port=0",
        `--user-data-dir=${dir}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const portFile = path.join(dir, "DevToolsActivePort");
    let port = 0;
    for (let attempt = 0; attempt < 50 && !port; attempt += 1) {
        try {
            port = Number((await readFile(portFile, "utf8")).split("\n")[0]);
        } catch {
            await delay(100);
        }
    }
    if (!port) throw new Error("Chrome did not expose a DevTools port");
    const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("Chrome DevTools socket failed"));
    });
    let sequence = 0;
    const pending = new Map();
    const exceptions = [];
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
            return;
        }
        if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    };
    function send(method, params = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }
    await send("Runtime.enable");
    await send("Page.enable");
    return {
        exceptions,
        async goto(url) {
            await send("Page.navigate", { url });
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                const ready = await send("Runtime.evaluate", {
                    expression: "document.readyState",
                    returnByValue: true,
                });
                if (ready.result.result?.value === "complete") return;
                await delay(50);
            }
            throw new Error(`page did not load ${url}`);
        },
        async evaluate(expression) {
            const message = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if (message.result.exceptionDetails) {
                const details = message.result.exceptionDetails;
                throw new Error(details.exception?.description || details.text);
            }
            return message.result.result.value;
        },
        async isAnimating() {
            const first = await this.evaluate("document.getElementById('board').toDataURL()");
            await delay(250);
            const second = await this.evaluate("document.getElementById('board').toDataURL()");
            return first !== second;
        },
        async stop() {
            ws.close();
            if (child.exitCode == null && child.signalCode == null) {
                child.kill("SIGKILL");
                await new Promise((resolve) => child.once("exit", resolve));
            }
            await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
    };
}

test("token pacman inherited character names", { concurrency: false, timeout: 120_000 }, async (t) => {
    const canvas = await loadCanvas();
    let chrome;
    try {

    await t.test("own character choices remain on every snapshot", async () => {
        const instanceId = "own-characters";
        const opened = await canvas.open({ instanceId });
        try {
            assert.equal(new URL(opened.url).hostname, "127.0.0.1");
            assert.equal(new URL(opened.url).search, "");
            const mrs = await request(`${opened.url}choose`, { method: "POST", body: JSON.stringify({ character: "mrs" }) });
            assert.equal(mrs.status, 200);
            assert.equal(ownCharacterError(mrs.json), null);
            assert.equal(mrs.json.character.name, "Mrs. Pac-Man");
            const mr = await request(`${opened.url}choose`, { method: "POST", body: JSON.stringify({ character: "mr" }) });
            assert.equal(mr.json.character.name, "Mr. Pac-Man");
            assert.equal(mr.json.character.color, "#ffd43b");
            const unknown = await request(`${opened.url}choose`, { method: "POST", body: JSON.stringify({ character: "ghost" }) });
            assert.equal(unknown.json.character.name, "Mr. Pac-Man");
            const invalid = await request(`${opened.url}choose`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{",
            });
            assert.equal(invalid.status, 400);
            const state = await request(`${opened.url}state`);
            assert.equal(state.json.character.name, "Mr. Pac-Man");
        } finally {
            await closeInstance(canvas, instanceId);
        }
    });

    await t.test("inherited names are ignored by choose and by every later snapshot lookup", async () => {
        const failures = [];
        const payloads = [
            ...INHERITED_NAMES.map((name) => ({ label: name, body: { character: name } })),
            { label: "array constructor", body: { character: ["constructor"] } },
            { label: "array toString", body: { character: ["toString"] } },
        ];
        for (const payload of payloads) {
            const instanceId = `inherited-${payload.label}`;
            const opened = await canvas.open({ instanceId });
            const stream = await openEvents(opened.url);
            try {
                if (!await waitForCount(stream.events, 1)) {
                    failures.push(`${payload.label}: no initial snapshot`);
                    continue;
                }
                const posted = payload.label === "constructor"
                    ? await rawPost(opened.url, {
                        host: "attacker.example",
                        path: "/choose",
                        headers: { "Content-Type": "text/plain" },
                        body: JSON.stringify(payload.body),
                    })
                    : await request(`${opened.url}choose`, { method: "POST", body: JSON.stringify(payload.body) });
                if (!posted.status) failures.push(`${payload.label}: choose produced no HTTP response`);
                const chooseError = ownCharacterError(posted.json);
                if (chooseError) failures.push(`${payload.label} POST /choose: ${chooseError}`);
                await waitForCount(stream.events, 2);
                stream.events.forEach((event, index) => {
                    const error = ownCharacterError(event);
                    if (error) failures.push(`${payload.label} SSE #${index}: ${error}`);
                });
                for (const path of ["state", "limit", "reset"]) {
                    const response = path === "state"
                        ? await request(`${opened.url}state`)
                        : await request(`${opened.url}${path}`, {
                            method: "POST",
                            body: path === "limit" ? JSON.stringify({ limit: 250 }) : JSON.stringify({}),
                        });
                    const error = ownCharacterError(response.json);
                    if (error) failures.push(`${payload.label} ${path}: ${error}`);
                }
                for (const action of canvas.actions) {
                    const returned = await action.handler({
                        instanceId,
                        input: action.name === "set_limit" ? { limit: 80 } : {},
                    });
                    const error = ownCharacterError(returned);
                    if (error) failures.push(`${payload.label} action ${action.name}: ${error}`);
                }
                stream.events.forEach((event, index) => {
                    const error = ownCharacterError(event);
                    if (error) failures.push(`${payload.label} SSE after actions #${index}: ${error}`);
                });
            } finally {
                await closeInstance(canvas, instanceId, stream);
            }
        }
        assert.deepEqual(failures, []);
    });

    await t.test("a local client without a token makes the open canvas throw and stops the loop", async () => {
        chrome = await launchChrome();
        const failures = [];
        for (const name of ["constructor", "toString"]) {
            const instanceId = `browser-${name}`;
            const opened = await canvas.open({ instanceId });
            const cursor = chrome.exceptions.length;
            try {
                assert.equal(new URL(opened.url).hostname, "127.0.0.1");
                await chrome.goto(opened.url);
                if (!await chrome.isAnimating()) failures.push(`${name}: canvas was not animating before the request`);
                const before = chrome.exceptions.length;
                const attacked = await rawPost(opened.url, {
                    host: `${new URL(opened.url).host}`,
                    path: "/choose",
                    headers: { "Content-Type": "text/plain" },
                    body: JSON.stringify({ character: name }),
                });
                await delay(400);
                const thrown = chrome.exceptions.slice(before).map((details) => details.exception?.description || details.text || "");
                if (thrown.length) failures.push(`${name}: page threw after choose\n${thrown.join("\n")}`);
                if (!await chrome.isAnimating()) failures.push(`${name}: animation loop stopped after choose`);
                const stateError = ownCharacterError((await request(`${opened.url}state`)).json);
                if (stateError) failures.push(`${name} /state: ${stateError}`);
                if (attacked.json) {
                    const chooseError = ownCharacterError(attacked.json);
                    if (chooseError) failures.push(`${name} choose response: ${chooseError}`);
                }
                const limitCursor = chrome.exceptions.length;
                await request(`${opened.url}limit`, { method: "POST", body: JSON.stringify({ limit: 500 }) });
                await canvas.actions.find((action) => action.name === "set_limit").handler({ instanceId, input: { limit: 400 } });
                await canvas.actions.find((action) => action.name === "reset_run").handler({ instanceId, input: {} });
                await canvas.actions.find((action) => action.name === "sync_usage").handler({ instanceId, input: {} });
                await delay(300);
                const later = chrome.exceptions.slice(limitCursor).map((details) => details.exception?.description || details.text || "");
                if (later.length) failures.push(`${name}: later snapshots still threw\n${later.join("\n")}`);
                if (!await chrome.isAnimating()) failures.push(`${name}: animation loop stayed stopped after later snapshots`);
                const finalError = ownCharacterError((await request(`${opened.url}state`)).json);
                if (finalError) failures.push(`${name} final /state: ${finalError}`);
                assert.equal(chrome.exceptions.slice(cursor, before).length, 0);
            } finally {
                await chrome.goto("about:blank");
                await closeInstance(canvas, instanceId);
            }
        }
        assert.deepEqual(failures, []);
    });

    await t.test("paint and draw skip a snapshot whose character name is missing", async () => {
        const instanceId = "client-guard";
        const opened = await canvas.open({ instanceId });
        const cursor = chrome.exceptions.length;
        try {
            await chrome.goto(opened.url);
            assert.equal(await chrome.isAnimating(), true);
            const missingCharacter = {
                credits: 0,
                limit: 100,
                dead: false,
                achievements: [],
                fruit: null,
                fruitVersion: 0,
                entitlement: null,
                runVersion: 0,
                percent: 0,
                nextMilestone: 10,
            };
            const namelessCharacter = { ...missingCharacter, character: {} };
            const outcome = await chrome.evaluate(`(() => {
                let frames = 0;
                const original = requestAnimationFrame;
                requestAnimationFrame = (callback) => {
                    frames += 1;
                    return original(callback);
                };
                const snapshots = ${JSON.stringify([missingCharacter, missingCharacter, namelessCharacter])};
                for (const snapshot of snapshots) {
                    try { paint(snapshot); } catch (error) { return { paint: String(error && error.message || error) }; }
                    try { draw(); } catch (error) { return { draw: String(error && error.message || error) }; }
                }
                return new Promise((resolve) => setTimeout(() => resolve({ ok: true, frames }), 300));
            })()`);
            assert.equal(outcome.paint, undefined, outcome.paint);
            assert.equal(outcome.draw, undefined, outcome.draw);
            assert.ok(outcome.frames >= 2, "animation loop stopped scheduling frames");
            assert.deepEqual(chrome.exceptions.slice(cursor).map((details) => details.exception?.description || details.text || ""), []);
        } finally {
            await chrome.goto("about:blank");
            await closeInstance(canvas, instanceId);
        }
    });

    } finally {
        await chrome?.stop();
    }
});
