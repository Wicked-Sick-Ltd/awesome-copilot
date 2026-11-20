// Tests for the loopback server that extension.mjs starts when the canvas opens.
// Run `node --test` in the extension folder.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const EXTENSION = fileURLToPath(new URL("./extension.mjs", import.meta.url));

// Stands in for @github/copilot-sdk/extension: opens the first canvas once and
// prints the URL it returns.
const SDK_STUB = `
export class CanvasError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
export function createCanvas(definition) { return definition; }
export async function joinSession({ canvases }) {
    const session = {
        workspacePath: null,
        send: async () => {},
        rpc: { metadata: { snapshot: async () => ({}) } },
    };
    setImmediate(async () => {
        const result = await canvases[0].open({
            instanceId: "test",
            session: { workingDirectory: process.env.WHERE_WAS_I_TEST_CWD },
        });
        process.stdout.write(JSON.stringify({ url: result.url }) + "\\n");
    });
    return session;
}
`;

function writeLoader(dir) {
    const stub = join(dir, "sdk-stub.mjs");
    const hooks = join(dir, "hooks.mjs");
    const register = join(dir, "register.mjs");
    writeFileSync(stub, SDK_STUB);
    writeFileSync(hooks, `
export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
    }
    return next(specifier, context);
}
`);
    writeFileSync(register, `
import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(hooks).href)});
`);
    return register;
}

async function startExtension(t) {
    const dir = mkdtempSync(join(tmpdir(), "where-was-i-server-"));
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const register = writeLoader(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh is disabled in tests' >&2\nexit 1\n", { mode: 0o755 });

    const child = spawn(process.execPath, ["--import", pathToFileURL(register).href, EXTENSION], {
        env: { ...process.env, WHERE_WAS_I_TEST_CWD: repo, PATH: `${bin}${delimiter}${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const ext = { child, stderr: "", exitCode: null };
    ext.exited = new Promise((resolve) => child.on("exit", (code, signal) => {
        ext.exitCode = code ?? signal;
        resolve();
    }));
    child.stderr.on("data", (chunk) => { ext.stderr += chunk; });
    t.after(async () => {
        if (ext.exitCode === null) {
            child.kill();
            await ext.exited;
        }
        rmSync(dir, { recursive: true, force: true });
    });

    ext.url = await new Promise((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (chunk) => {
            out += chunk;
            const line = out.split("\n").find((l) => l.startsWith("{"));
            if (line) resolve(new URL(JSON.parse(line).url));
        });
        child.on("exit", () => reject(new Error(`extension exited before opening:\n${ext.stderr}`)));
    });
    return ext;
}

// Sends a raw request so the request-target reaches the server unaltered.
function rawRequest(port, target, host) {
    return new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        let data = "";
        socket.on("connect", () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        });
        socket.on("data", (chunk) => { data += chunk; });
        socket.on("error", () => {});
        socket.on("close", () => {
            const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
            resolve(match ? Number(match[1]) : null);
        });
    });
}

// Starts a POST with a body it never finishes, then drops the connection.
function abortedPost(port, target, host) {
    return new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.on("connect", () => {
            socket.write(`POST ${target} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"thr`);
            setTimeout(() => socket.destroy(), 100);
        });
        socket.on("error", () => {});
        socket.on("close", resolve);
    });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("request targets that are not plain paths get 400 and leave the extension running", async (t) => {
    const ext = await startExtension(t);
    const port = Number(ext.url.port);
    const host = ext.url.host;
    const token = ext.url.searchParams.get("k");

    const targets = ["//", "///", "//@", "/\\", "//evil.example/context", "/\\evil.example/context", "*", "http://evil.example/context"];
    for (const target of targets) {
        const status = await rawRequest(port, target, host);
        await settle();
        assert.equal(ext.exitCode, null, `extension exited after GET ${target}:\n${ext.stderr}`);
        assert.equal(status, 400, `GET ${target}`);
    }

    assert.equal(await rawRequest(port, `/context?k=${encodeURIComponent(token)}`, host), 200);
    assert.equal(await rawRequest(port, "/context", host), 403);
    assert.equal(await rawRequest(port, `//?k=${encodeURIComponent(token)}`, host), 400);
    await settle();
    assert.equal(ext.exitCode, null, ext.stderr);
});

test("a client that drops a request mid-body does not exit the extension", async (t) => {
    const ext = await startExtension(t);
    const port = Number(ext.url.port);
    const host = ext.url.host;
    const token = ext.url.searchParams.get("k");

    await abortedPost(port, `/resume?k=${encodeURIComponent(token)}`, host);
    await settle();
    assert.equal(ext.exitCode, null, `extension exited after an aborted request:\n${ext.stderr}`);
    assert.equal(await rawRequest(port, `/context?k=${encodeURIComponent(token)}`, host), 200);
});
