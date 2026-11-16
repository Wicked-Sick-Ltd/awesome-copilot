// Spec for the Diagram Explorer loopback server: a request the HTTP parser
// accepts must not reject the async listener. These tests fail while
// extension.mjs builds `new URL(req.url, http://${req.headers.host})` before
// validateToken and outside a try/catch.
//
// Run from the repository root:
//   node --test extensions/diagram-viewer/test/malformed-host-crash.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const register = path.join(here, "support", "register-sdk-stub.mjs");
const exercise = path.join(here, "support", "exercise-server.mjs");

const cases = [
  "get-root-empty-host",
  "get-root-bracket-host",
  "get-events-bracket-dot-host",
  "get-state-closing-bracket-host",
  "post-click-oversized-port-host",
  "post-back-alpha-port-host",
  "get-unknown-empty-host",
  "get-root-absolute-invalid-target",
  "get-root-triple-slash-target",
  "get-root-backslash-target",
  "control-canonical-host-without-token",
];

async function runCase(caseName) {
  const child = spawn(process.execPath, ["--import", register, exercise, caseName], {
    cwd: path.resolve(here, ".."),
    env: { ...process.env, NODE_OPTIONS: "" },
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
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 8000);
    child.on("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolve(signal ? `signal ${signal}` : exitCode);
    });
  });
  return { code, stdout, stderr };
}

for (const caseName of cases) {
  test(caseName, async () => {
    const { code, stdout, stderr } = await runCase(caseName);
    assert.equal(
      code,
      0,
      [
        `${caseName}: the extension process must stay alive and refuse the request`,
        `before any canvas HTML is served.`,
        `exit=${code}`,
        `stdout=${stdout}`,
        `stderr=${stderr}`,
      ].join("\n"),
    );
    const line = stdout.trim().split("\n").at(-1);
    const result = JSON.parse(line);
    assert.equal(result.ok, true, JSON.stringify(result));
  });
}
