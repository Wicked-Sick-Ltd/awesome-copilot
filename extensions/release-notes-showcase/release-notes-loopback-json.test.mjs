// Invalid JSON on the Release Notes loopback must be a 400 from the request
// handler. While the parse rejection is unhandled, these tests fail because
// the extension process exits and the canvas stops answering.
//
// Run from this directory, with Node.js 24 (the runtime bundled in
// @github/copilot 1.0.63):
//   npm ci --omit=optional --ignore-scripts
//   node --test release-notes-loopback-json.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverScript = fileURLToPath(import.meta.url);
const extensionDir = fileURLToPath(new URL(".", import.meta.url));
const untouchedMarker = "No release data loaded yet";

if (process.argv.includes("--serve")) {
    const { releaseNotesShowcaseCanvas } = await import("./releaseNotesShowcase.mjs");
    const opened = await releaseNotesShowcaseCanvas.open({
        instanceId: "release-notes-invalid-json",
        sessionId: "release-notes-invalid-json",
        session: { workingDirectory: extensionDir },
        input: {},
    });
    process.stdout.write(`READY ${opened.url}\n`);
    await new Promise(() => {});
}

function childEnv() {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    delete env.SESSION_ID;
    delete env.COPILOT_AGENT_SESSION_ID;
    for (const key of Object.keys(env)) {
        if (key.startsWith("COPILOT_GH_ACCOUNT_")) {
            delete env[key];
        }
    }
    return env;
}

function startCanvas() {
    const child = spawn(process.execPath, [serverScript, "--serve"], {
        cwd: extensionDir,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
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

    let settled = false;
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error(`canvas did not listen\n${stderr}\n${stdout}`));
        }, 8000);

        const finishReady = () => {
            const match = stdout.match(/READY (http:\/\/127\.0\.0\.1:\d+\/)/);
            if (!match || settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(new URL(match[1]));
        };

        child.stdout.on("data", finishReady);
        child.on("exit", (code, signal) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(
                new Error(
                    `canvas exited before listening code=${code} signal=${signal}\n${stderr}`,
                ),
            );
        });
    });

    return {
        child,
        ready,
        output() {
            return { stdout, stderr };
        },
    };
}

function send(url, { method, path, body, headers }) {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                method,
                path,
                headers,
                agent: false,
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
        req.setTimeout(3000, () => req.destroy(new Error(`${method} ${path} timed out`)));
        req.on("error", reject);
        if (body === undefined) {
            req.end();
        } else {
            req.end(body);
        }
    });
}

async function withCanvas(t, run) {
    const canvas = startCanvas();
    t.after(() => {
        if (canvas.child.exitCode === null && canvas.child.signalCode === null) {
            canvas.child.kill("SIGTERM");
        }
    });
    const base = await canvas.ready;
    await run(canvas, base);
}

async function postInvalid(base, route) {
    return send(base, {
        method: "POST",
        path: route.path,
        headers: { "content-type": route.contentType },
        body: route.body,
    });
}

const routes = [
    {
        name: "export-email",
        path: "/actions/export-email",
        body: "not-json",
        contentType: "text/plain;charset=utf-8",
    },
    {
        name: "load-release",
        path: "/actions/load-release",
        body: "{",
        contentType: "application/json",
    },
];

for (const route of routes) {
    test(`POST ${route.path} returns 400 for invalid JSON and the canvas stays up`, async (t) => {
        await withCanvas(t, async (canvas, base) => {
            const before = await send(base, { method: "GET", path: "/" });
            assert.equal(before.status, 200);
            assert.match(before.body, new RegExp(untouchedMarker));

            let response;
            try {
                response = await postInvalid(base, route);
            } catch (error) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                const { stderr } = canvas.output();
                assert.fail(
                    `POST ${route.path} did not answer 400 (${error.message}). ` +
                        `process exit=${canvas.child.exitCode} signal=${canvas.child.signalCode}\n${stderr}`,
                );
            }

            assert.equal(response.status, 400);
            const after = await send(base, { method: "GET", path: "/" });
            assert.equal(
                after.body,
                before.body,
                "invalid JSON changed the open canvas before the request was refused",
            );

            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.equal(
                canvas.child.exitCode,
                null,
                "extension process exited after invalid JSON",
            );
            assert.equal(canvas.child.signalCode, null);

            const exported = await send(base, {
                method: "POST",
                path: "/actions/export-email",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ format: "text" }),
            });
            assert.equal(exported.status, 200);
            const payload = JSON.parse(exported.body);
            assert.equal(typeof payload.text, "string");
            assert.match(payload.text, new RegExp(untouchedMarker));
        });
    });
}
