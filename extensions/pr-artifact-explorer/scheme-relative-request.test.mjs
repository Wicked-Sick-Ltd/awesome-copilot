import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(new URL("./scheme-relative-request.harness.mjs", import.meta.url));

// Request targets Node's HTTP parser delivers to the handler and that
// `new URL(target, "http://127.0.0.1")` rejects. Each one reaches
// handleRequest before the host and capability-token checks.
const invalidRequests = [
  ["GET", "//"],
  ["POST", "//"],
  ["PUT", "//"],
  ["DELETE", "//"],
  ["PATCH", "//"],
  ["OPTIONS", "//"],
  ["GET", "///"],
  ["GET", "//?"],
  ["GET", "//#"],
  ["GET", "http://"],
  ["GET", "http:///"],
];

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (
      key === "GH_TOKEN" ||
      key === "GITHUB_TOKEN" ||
      key.startsWith("COPILOT_GH_ACCOUNT_") ||
      key.includes("TOKEN") ||
      key.includes("SECRET") ||
      key.includes("PASSWORD") ||
      key.includes("KEY")
    ) {
      delete env[key];
    }
  }
  return env;
}

function rawHttp(port, method, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error(`timed out waiting for ${method} ${target}`));
    }, 2000);
    socket.on("error", (error) => {
      finish(reject, error);
    });
    socket.on("close", () => {
      finish(
        reject,
        new Error(`connection closed before a complete HTTP response for ${method} ${target}`),
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = buffer.subarray(0, headerEnd).toString("latin1");
      const status = Number(/^HTTP\/1\.[01] (\d{3})\b/.exec(headerText)?.[1]);
      const length = Number(/content-length:\s*(\d+)/i.exec(headerText)?.[1]);
      if (!Number.isInteger(status) || !Number.isInteger(length)) {
        finish(reject, new Error(`incomplete HTTP response for ${method} ${target}`));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      socket.end();
      finish(resolve, {
        status,
        body: buffer.subarray(bodyStart, bodyStart + length).toString("utf8"),
      });
    });
    socket.end(
      `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
  });
}

async function readResponse(port, method, target, harness) {
  try {
    return await rawHttp(port, method, target);
  } catch (error) {
    await delay(200);
    const exitCode = harness.child.exitCode;
    const stderr = harness.errors().slice(0, 800);
    assert.fail(
      `${method} ${target} did not receive a completed HTTP response (${error.message}). ` +
        `server exit=${exitCode}. ` +
        "An invalid request target must be answered with HTTP 400 and must not close the server." +
        (stderr ? `\n${stderr}` : ""),
    );
  }
}

function startHarness() {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [harnessPath], {
    cwd: dirname(harnessPath),
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return {
    child,
    output: () => Buffer.concat(stdout).toString("utf8"),
    errors: () => Buffer.concat(stderr).toString("utf8"),
  };
}

async function waitForPort(child, output) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) {
      assert.fail(`canvas server exited before accepting a connection (${child.exitCode})`);
    }
    const match = /READY (\d+)/.exec(output());
    if (match) return Number(match[1]);
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit"),
      delay(50),
    ]);
  }
  assert.fail(`canvas server did not report a port\n${output()}`);
}

async function withCanvasServer(check) {
  const harness = startHarness();
  try {
    const port = await waitForPort(harness.child, harness.output);
    await check(port, harness);
    await delay(400);
    assert.equal(
      harness.child.exitCode,
      null,
      `canvas server exited after the request\n${harness.errors()}`,
    );
    assert.doesNotMatch(harness.errors(), /ERR_INVALID_URL/);
  } finally {
    if (harness.child.exitCode === null && harness.child.signalCode === null) {
      harness.child.kill("SIGKILL");
    }
    await Promise.race([once(harness.child, "exit"), delay(1000)]);
  }
}

async function expectInvalidTargetRejected(port, method, target, harness) {
  const response = await readResponse(port, method, target, harness);
  assert.equal(response.status, 400, response.body);
  const payload = JSON.parse(response.body);
  assert.equal(payload.status, 400);
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length > 0);
}

async function expectUnauthenticatedRootRejected(port, harness) {
  const response = await readResponse(port, "GET", "/", harness);
  assert.equal(response.status, 403, response.body);
  const payload = JSON.parse(response.body);
  assert.equal(payload.status, 403);
}

for (const [method, target] of invalidRequests) {
  test(`canvas server answers ${method} ${target} with HTTP 400 and stays alive`, async () => {
    await withCanvasServer(async (port, harness) => {
      await expectInvalidTargetRejected(port, method, target, harness);
      await expectUnauthenticatedRootRejected(port, harness);
    });
  });
}

test("one canvas server survives every invalid request target and still enforces the root token", async () => {
  await withCanvasServer(async (port, harness) => {
    for (const [method, target] of invalidRequests) {
      await expectInvalidTargetRejected(port, method, target, harness);
    }
    await expectUnauthenticatedRootRejected(port, harness);
  });
});
