import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(import.meta.url);

// Request targets that Node's HTTP parser delivers to req.url and that
// `new URL(target, "http://127.0.0.1")` rejects. They all enter the canvas
// through the same uncaught parse at the start of the request handler.
const crashingTargets = [
    { method: "GET", target: "//" },
    { method: "POST", target: "//" },
    { method: "GET", target: "///" },
    { method: "GET", target: "//?" },
    { method: "GET", target: "//?x=1" },
    { method: "GET", target: "//#" },
    { method: "GET", target: "//#frag" },
    { method: "GET", target: "//:" },
    { method: "GET", target: "/\\" },
    { method: "GET", target: "/\\/" },
    { method: "GET", target: "///?" },
];

if (process.argv[2] === "--serve") {
    const { releaseNotesShowcaseCanvas } = await import("./releaseNotesShowcase.mjs");
    const marker = process.env.RELEASE_NOTES_MARKER ?? "";
    const opened = await releaseNotesShowcaseCanvas.open({
        instanceId: "scheme-relative-url",
        sessionId: "",
        input: {
            releaseName: marker,
            version: "9.9.9",
            summary: "Unexported release draft.",
        },
        session: { workingDirectory: process.cwd() },
    });
    process.stdout.write(`READY ${opened.url}\n`);
} else {
    test("scheme-relative request targets do not crash the release notes canvas", async (t) => {
        for (const spec of crashingTargets) {
            await t.test(`${spec.method} ${JSON.stringify(spec.target)} returns 400 and keeps the draft`, async () => {
                const marker = `DraftMarker${spec.method}${Buffer.from(spec.target, "latin1").toString("hex")}`;
                const canvas = await startCanvas(marker);
                try {
                    const home = await sendRaw(canvas.port, "GET", "/");
                    assert.equal(home.status, 200, canvas.failure("opening the canvas"));
                    assert.match(home.raw, new RegExp(marker), canvas.failure("draft was not rendered"));

                    const missing = await sendRaw(canvas.port, "GET", "/missing");
                    assert.equal(missing.status, 404, canvas.failure("unexpected route"));
                    assert.match(missing.raw, /"error":"Not found"/);

                    const attack = await sendRaw(canvas.port, spec.method, spec.target);
                    await delay(300);
                    assert.equal(canvas.child.exitCode, null, canvas.failure("process exited after the request"));
                    assert.equal(canvas.child.signalCode, null, canvas.failure("process was signaled"));
                    assert.equal(attack.status, 400, canvas.failure("scheme-relative target was not refused"));

                    const after = await sendRaw(canvas.port, "GET", "/");
                    assert.equal(canvas.child.exitCode, null, canvas.failure("process exited after the follow-up"));
                    assert.equal(after.status, 200, canvas.failure("canvas stopped serving the draft"));
                    assert.match(after.raw, new RegExp(marker), canvas.failure("unexported draft was lost"));

                    const stillRouted = await sendRaw(canvas.port, "GET", "/missing");
                    assert.equal(stillRouted.status, 404, canvas.failure("routing broke after the refused request"));
                } finally {
                    canvas.stop();
                }
            });
        }
    });
}

function startCanvas(marker) {
    const env = { ...process.env, RELEASE_NOTES_MARKER: marker };
    delete env.NODE_OPTIONS;

    const child = spawn(process.execPath, [harnessPath, "--serve"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        execArgv: [],
        env,
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

    const canvas = {
        child,
        port: 0,
        failure(step) {
            return `${step}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        },
        stop() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
            }
        },
    };

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            canvas.stop();
            reject(new Error(canvas.failure("canvas did not listen")));
        }, 5000);
        const onExit = (code, signal) => {
            clearTimeout(timer);
            reject(new Error(canvas.failure(`canvas exited before listening (code=${code}, signal=${signal})`)));
        };
        child.once("exit", onExit);
        child.stdout.on("data", () => {
            const match = stdout.match(/READY http:\/\/127\.0\.0\.1:(\d+)\//);
            if (!match) {
                return;
            }
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            canvas.port = Number(match[1]);
            resolve(canvas);
        });
    });
}

function sendRaw(port, method, target) {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const chunks = [];
        let settled = false;
        const finish = (extra) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString("latin1");
            const match = raw.match(/^HTTP\/1\.[01] (\d{3})/);
            resolve({ status: match ? Number(match[1]) : null, raw, ...extra });
        };
        const timer = setTimeout(() => {
            socket.destroy();
            finish({ timedOut: true });
        }, 1000);
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", (error) => finish({ error: error.code }));
        socket.on("end", () => finish({}));
        socket.on("connect", () => {
            socket.end(
                Buffer.from(
                    `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                    "latin1",
                ),
            );
        });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
