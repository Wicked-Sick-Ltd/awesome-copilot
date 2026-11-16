// Runs the real extension.mjs in a child process with the host SDK stubbed, so a
// request that throws outside the handler shows up as the process exiting.
// Run `node --test` in the extension folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION = fileURLToPath(new URL("./extension.mjs", import.meta.url));

const SDK_STUB = `
export class CanvasError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
export const createCanvas = (definition) => definition;
export async function joinSession({ canvases }) {
    const { url } = canvases[0].open();
    process.stdout.write(JSON.stringify({ url }) + "\\n");
    return { send: ({ prompt }) => process.stdout.write(JSON.stringify({ sent: prompt }) + "\\n") };
}
`;

async function startExtension(t) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "feedback-themes-test-"));
    const stubUrl = pathToFileURL(path.join(dir, "sdk-stub.mjs")).href;
    await writeFile(path.join(dir, "sdk-stub.mjs"), SDK_STUB);
    await writeFile(path.join(dir, "hooks.mjs"), `
export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    return next(specifier, context);
}
`);
    await writeFile(path.join(dir, "register.mjs"), `
import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(path.join(dir, "hooks.mjs")).href)});
`);

    const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(dir, "register.mjs")).href, EXTENSION], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const ext = { child, stderr: "", sent: [], exit: null };
    child.stderr.on("data", (chunk) => (ext.stderr += chunk));
    ext.exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve((ext.exit = { code, signal }))));
    t.after(async () => {
        if (!ext.exit) child.kill();
        await ext.exited;
        await rm(dir, { recursive: true, force: true });
    });

    ext.url = await new Promise((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                const message = JSON.parse(line);
                if (message.url) resolve(new URL(message.url));
                if (message.sent) ext.sent.push(message.sent);
            }
        });
        ext.exited.then(() => reject(new Error(`extension exited before listening:\n${ext.stderr}`)));
    });
    return ext;
}

function request(ext, { method = "GET", path: urlPath = "/api/state", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: ext.url.hostname, port: ext.url.port, method, path: urlPath, headers, agent: false },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
            },
        );
        req.setTimeout(5000, () => req.destroy(new Error(`${method} ${urlPath} timed out`)));
        req.on("error", reject);
        req.end(body);
    });
}

async function assertStillServing(ext) {
    // Give an uncaught exception from the previous request time to end the process.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ext.exit, null, `extension process exited: ${JSON.stringify(ext.exit)}\n${ext.stderr}`);
    const res = await request(ext);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).totalThemes, 6);
}

async function explore(ext, body, headers = {}) {
    return request(ext, {
        method: "POST",
        path: "/api/explore-theme",
        headers: { "Content-Type": "text/plain", ...headers },
        body,
    }).catch((error) => ({ status: null, error }));
}

test("malformed JSON body is rejected with 400 and the extension keeps running", async (t) => {
    const ext = await startExtension(t);
    const res = await explore(ext, "{");
    await assertStillServing(ext);
    assert.equal(res.status, 400);
    assert.equal(ext.sent.length, 0);
});

test("a JSON body that is not an object is rejected with 400", async (t) => {
    const ext = await startExtension(t);
    for (const body of ["null", "42", '"themeId"', "[]"]) {
        const res = await explore(ext, body);
        await assertStillServing(ext);
        assert.equal(res.status, 400, `body ${body}`);
    }
    assert.equal(ext.sent.length, 0);
});

test("an oversized body is rejected with 413 and the extension keeps running", async (t) => {
    const ext = await startExtension(t);
    const body = JSON.stringify({ themeId: "workflow-automation", pad: "a".repeat(128 * 1024) });
    const res = await explore(ext, body, { "Content-Type": "application/json" });
    await assertStillServing(ext);
    assert.equal(res.status, 413);
    assert.equal(ext.sent.length, 0);
});

test("a Host header that is not a valid URL authority does not end the process", async (t) => {
    const ext = await startExtension(t);
    await request(ext, { headers: { Host: "[" } }).catch(() => {});
    await assertStillServing(ext);
});

test("a valid explore request still starts a session on the theme", async (t) => {
    const ext = await startExtension(t);
    const res = await explore(ext, JSON.stringify({ themeId: "workflow-automation" }), {
        "Content-Type": "application/json",
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).ok, true);
    await assertStillServing(ext);
    assert.equal(ext.sent.length, 1);
    assert.match(ext.sent[0], /feedback theme in depth/);

    const missing = await explore(ext, JSON.stringify({ themeId: "no-such-theme" }));
    assert.equal(missing.status, 404);
    await assertStillServing(ext);
});
