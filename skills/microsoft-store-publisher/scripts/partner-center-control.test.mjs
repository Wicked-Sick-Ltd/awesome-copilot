import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

// Drives the real `launch` command against a local Chromium-family browser.
// The Partner Center start page is answered by a local HTTPS server so the
// test never reaches Microsoft.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const controlScript = path.join(scriptDir, "partner-center-control.mjs");
const sessionFileName = ".partner-center-control-session.json";

function findBrowser() {
  const candidates = [
    process.env.PARTNER_CENTER_TEST_BROWSER,
    "microsoft-edge-stable",
    "microsoft-edge",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "google-chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return execFileSync("sh", ["-c", 'command -v "$1"', "sh", candidate], {
        encoding: "utf8",
      }).trim();
    } catch {}
  }
  return null;
}

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const browserPath = process.platform === "win32" ? null : findBrowser();
const skip =
  process.platform === "win32"
    ? "POSIX-only harness"
    : !browserPath
      ? "no Chromium-family browser found; set PARTNER_CENTER_TEST_BROWSER"
      : !hasOpenssl()
        ? "openssl is required to serve the local start page"
        : false;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runControl(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [controlScript, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function browserCommandLines(profileDir) {
  const lines = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (cmdline.includes(profileDir)) {
      lines.push(cmdline.split("\0").filter(Boolean));
    }
  }
  return lines;
}

let tempDir;
let profileDir;
let debugPort;
let env;
let pageServer;
let launchProcess;
let launchExit;

before(async () => {
  if (skip) return;
  tempDir = mkdtempSync(path.join(os.tmpdir(), "partner-center-control-"));
  profileDir = path.join(tempDir, "profile");

  const keyPath = path.join(tempDir, "key.pem");
  const certPath = path.join(tempDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=storedeveloper.microsoft.com",
      "-keyout", keyPath, "-out", certPath,
    ],
    { stdio: "ignore" },
  );
  pageServer = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Partner Center stand-in</title><p>signed in</p>");
    },
  );
  await new Promise((resolve) => pageServer.listen(0, "127.0.0.1", resolve));

  const wrapper = path.join(tempDir, "msedge");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `exec "${browserPath}" "$@" --headless=new --ignore-certificate-errors ` +
        `--host-resolver-rules="MAP storedeveloper.microsoft.com 127.0.0.1:${pageServer.address().port}"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);

  debugPort = await freePort();
  env = {
    ...process.env,
    PARTNER_CENTER_EDGE_PATH: wrapper,
    PARTNER_CENTER_PROFILE: profileDir,
    PARTNER_CENTER_DEBUG_PORT: String(debugPort),
  };
  delete env.PARTNER_CENTER_ALLOW_WRITE;
  delete env.PARTNER_CENTER_PAGE_INDEX;
  delete env.PARTNER_CENTER_CDP_ENDPOINT;

  launchProcess = spawn(process.execPath, [controlScript, "launch"], { env });
  launchExit = new Promise((resolve) => launchProcess.on("exit", resolve));
  let output = "";
  launchProcess.stderr.on("data", (chunk) => (output += chunk));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`launch did not become ready:\n${output}`)),
      60000,
    );
    launchProcess.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
    launchProcess.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`launch exited with ${code}:\n${output}`));
    });
  });
});

after(async () => {
  if (skip) return;
  if (launchProcess && launchProcess.exitCode === null) {
    launchProcess.kill("SIGKILL");
    await launchExit;
  }
  pageServer?.closeAllConnections();
  pageServer?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test(
  "launch does not expose the signed-in browser on a DevTools port",
  { skip },
  async () => {
    // What any other local process could do: attach without a credential.
    let attached;
    try {
      attached = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
        timeout: 5000,
      });
    } catch {
      attached = null;
    }
    if (attached) {
      const urls = attached
        .contexts()
        .flatMap((context) => context.pages())
        .map((page) => page.url());
      await attached.close();
      assert.fail(
        `an unauthenticated client attached to the publisher browser: ${urls.join(", ")}`,
      );
    }

    const commandLines = browserCommandLines(profileDir);
    assert.ok(commandLines.length > 0, "the launched browser should be running");
    for (const argv of commandLines) {
      assert.ok(
        !argv.some((arg) => arg.startsWith("--remote-debugging-port")),
        `browser was started with a DevTools port: ${argv.join(" ")}`,
      );
    }
    assert.equal(
      existsSync(path.join(profileDir, "DevToolsActivePort")),
      false,
      "the browser published a DevTools port in its profile",
    );
  },
);

test("commands still drive the launched browser", { skip }, async () => {
  const result = await runControl(env, "status");
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.url, "https://storedeveloper.microsoft.com/");
  assert.equal(status.title, "Partner Center stand-in");
});

test(
  "the session channel refuses clients without the session token",
  { skip },
  async () => {
    const sessionFile = path.join(profileDir, sessionFileName);
    assert.ok(existsSync(sessionFile), "launch should record its session");
    assert.equal(
      statSync(sessionFile).mode & 0o077,
      0,
      "the session file must be readable only by its owner",
    );
    const { port } = JSON.parse(readFileSync(sessionFile, "utf8"));
    const body = JSON.stringify({ command: "text", args: [] });

    for (const headers of [
      {},
      { authorization: "Bearer placeholder-not-the-session-token" },
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      assert.equal(response.status, 401);
      assert.ok(!(await response.text()).includes("signed in"));
    }
  },
);

test("close shuts the publisher browser down", { skip }, async () => {
  const result = await runControl(env, "close");
  assert.equal(result.code, 0, result.stderr);
  const code = await Promise.race([
    launchExit,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 30000).unref()),
  ]);
  assert.equal(code, 0);
  assert.equal(existsSync(path.join(profileDir, sessionFileName)), false);
  assert.deepEqual(browserCommandLines(profileDir), []);
});
