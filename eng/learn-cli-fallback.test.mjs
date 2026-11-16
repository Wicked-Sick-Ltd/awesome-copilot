// Fails while the Microsoft docs skills tell an agent to run an unpinned
// @microsoft/learn-cli. npx and npm install -g resolve a bare name to the
// registry dist-tag "latest" and execute that package. The assertion passes
// once those commands are removed or name a version that is not the current
// latest release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const NPM_ROOT = "/exec-daemon/lib/node_modules/npm";
const NODE_BIN = "/exec-daemon/node";
const NPX_BIN = "/exec-daemon/npx";

// Skills that document the same unpinned @microsoft/learn-cli fallback.
const SKILL_FILES = [
  "skills/microsoft-docs/SKILL.md",
  "skills/microsoft-code-reference/SKILL.md",
  "skills/microsoft-skill-creator/SKILL.md",
  "skills/microsoft-skill-creator/references/skill-templates.md",
];

const PACKAGE_NAME = "@microsoft/learn-cli";
const LATEST_VERSION = "9.9.9";
const PINNED_VERSION = "1.0.0";

function normalizeCommand(command) {
  let normalized = command.trim();
  if (normalized.endsWith(".") && !normalized.endsWith("...")) {
    normalized = normalized.slice(0, -1).trim();
  }
  return normalized;
}

function isFallbackCommand(command) {
  const isLearnPackage = command.includes(PACKAGE_NAME);
  if (command.startsWith("npx ") && isLearnPackage) {
    return true;
  }
  if (/^npm\s+(?:install|i)\s+-g\s+/.test(command) && isLearnPackage) {
    return true;
  }
  return /^mslearn\s+\S+/.test(command);
}

function extractFallbackCommands(source) {
  // The skill tells the agent to substitute the user's documentation query
  // for this placeholder. The package spec itself is left unchanged.
  const text = source.replaceAll("<command>", 'search "BlobClient UploadAsync"');
  const commands = [];
  const accept = (command) => {
    const normalized = normalizeCommand(command);
    if (normalized && isFallbackCommand(normalized)) {
      commands.push(normalized);
    }
  };

  for (const span of text.matchAll(/`([^`\n]+)`/g)) {
    accept(span[1]);
  }

  for (const fence of text.matchAll(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g)) {
    for (const line of fence[1].split("\n")) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) {
        continue;
      }
      accept(stripped);
    }
  }

  return [...new Set(commands)];
}

function scriptsFor(commands) {
  const direct = commands.filter((command) => command.startsWith("npx "));
  const installs = commands.filter((command) => command.startsWith("npm "));
  const mslearn = commands.filter((command) => command.startsWith("mslearn "));
  const scripts = direct.map((command) => command);
  for (const install of installs) {
    scripts.push([install, ...mslearn].join("\n"));
  }
  if (installs.length === 0) {
    for (const command of mslearn) {
      scripts.push(command);
    }
  }
  return scripts;
}

function packumentFor(versions, tarballBase) {
  const versionDocs = {};
  for (const version of versions) {
    versionDocs[version.version] = {
      name: PACKAGE_NAME,
      version: version.version,
      dist: {
        tarball: `${tarballBase}/${version.file}`,
        shasum: version.shasum,
        integrity: version.integrity,
      },
      bin: { mslearn: "bin.js" },
      scripts: version.scripts,
    };
  }
  return {
    name: PACKAGE_NAME,
    "dist-tags": { latest: LATEST_VERSION },
    versions: versionDocs,
  };
}

function startRegistry(state, files) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    const pathname = decodeURIComponent(url.pathname);
    if (req.method === "GET" && (pathname === `/${PACKAGE_NAME}` || url.pathname === "/@microsoft%2flearn-cli")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.packument));
      return;
    }
    const fileName = path.basename(pathname);
    if (req.method === "GET" && files.has(fileName)) {
      res.setHeader("content-type", "application/octet-stream");
      fs.createReadStream(files.get(fileName)).pipe(res);
      return;
    }
    if (req.method === "POST" || req.method === "PUT") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found", path: pathname }));
  });
  server.listen(0, "127.0.0.1");
  return { server, requests, ready: once(server, "listening") };
}

async function packPackage(dir, version, scripts) {
  const pkgDir = path.join(dir, version);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
    name: PACKAGE_NAME,
    version,
    bin: { mslearn: "bin.js" },
    scripts,
  }));
  fs.writeFileSync(path.join(pkgDir, "bin.js"), `#!/usr/bin/env node
const fs = require("node:fs");
const pkg = require("./package.json");
fs.appendFileSync(process.env.LEARN_CLI_MARKER, JSON.stringify({
  version: pkg.version,
  via: "bin",
  argv: process.argv.slice(2),
}) + "\\n");
`);
  fs.writeFileSync(path.join(pkgDir, "preinstall.js"), `const fs = require("node:fs");
const pkg = require("./package.json");
fs.appendFileSync(process.env.LEARN_CLI_MARKER, JSON.stringify({
  version: pkg.version,
  via: "preinstall",
}) + "\\n");
`);
  fs.chmodSync(path.join(pkgDir, "bin.js"), 0o755);
  const pack = await runProcess(NODE_BIN, [
    path.join(NPM_ROOT, "bin/npm-cli.js"),
    "pack",
    "--pack-destination",
    dir,
    "--ignore-scripts",
  ], { cwd: pkgDir, env: process.env });
  assert.equal(pack.code, 0, pack.stderr || pack.stdout);
  const file = pack.stdout.trim().split("\n").at(-1);
  const tarball = path.join(dir, file);
  const bytes = fs.readFileSync(tarball);
  return {
    version,
    file,
    tarball,
    scripts,
    shasum: crypto.createHash("sha1").update(bytes).digest("hex"),
    integrity: "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64"),
  };
}

function runProcess(command, args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function runSkillScript(script, registryUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-cli-fallback-"));
  const home = path.join(root, "home");
  const prefix = path.join(root, "prefix");
  const cache = path.join(root, "cache");
  const work = path.join(root, "work");
  const shims = path.join(root, "shims");
  const marker = path.join(root, "marker.log");
  for (const dir of [home, prefix, path.join(prefix, "bin"), cache, work, shims]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(shims, "npm"), `#!/bin/sh
exec "${NODE_BIN}" "${path.join(NPM_ROOT, "bin/npm-cli.js")}" "$@"
`);
  fs.writeFileSync(path.join(shims, "npx"), `#!/bin/sh
exec "${NPX_BIN}" "$@"
`);
  fs.symlinkSync(NODE_BIN, path.join(shims, "node"));
  fs.chmodSync(path.join(shims, "npm"), 0o755);
  fs.chmodSync(path.join(shims, "npx"), 0o755);
  fs.writeFileSync(path.join(home, ".npmrc"), "");
  const env = {
    PATH: `${path.join(prefix, "bin")}${path.delimiter}${shims}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: home,
    TMPDIR: root,
    LEARN_CLI_MARKER: marker,
    npm_config_registry: registryUrl,
    npm_config_cache: cache,
    npm_config_prefix: prefix,
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0",
    npm_config_loglevel: "error",
  };
  const result = await runProcess("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: work,
    env,
  });
  const executions = fs.existsSync(marker)
    ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  fs.rmSync(root, { recursive: true, force: true });
  return { ...result, executions };
}

test("Microsoft docs CLI fallback does not run the latest learn-cli release", { timeout: 180000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "learn-cli-registry-"));
  const compromised = await packPackage(scratch, LATEST_VERSION, { preinstall: "node preinstall.js" });
  const reviewed = await packPackage(scratch, PINNED_VERSION, {});
  const files = new Map([
    [compromised.file, compromised.tarball],
    [reviewed.file, reviewed.tarball],
  ]);
  const state = { packument: null };
  const { server, requests, ready } = startRegistry(state, files);
  await ready;
  const registryUrl = `http://127.0.0.1:${server.address().port}`;
  state.packument = packumentFor(
    [reviewed, compromised],
    `${registryUrl}/tarballs`,
  );
  try {
    const control = await runSkillScript(
      `npx ${PACKAGE_NAME}@${LATEST_VERSION} search "control"`,
      registryUrl,
    );
    assert.ok(
      control.executions.some((entry) => entry.version === LATEST_VERSION && entry.via === "bin"),
      `the local registry harness must execute ${PACKAGE_NAME}@${LATEST_VERSION} when the spec names that version.\nstdout:\n${control.stdout}\nstderr:\n${control.stderr}\nrequests:\n${requests.join("\n")}`,
    );

    const pinned = await runSkillScript(
      `npx ${PACKAGE_NAME}@${PINNED_VERSION} search "pinned"`,
      registryUrl,
    );
    assert.ok(
      pinned.executions.some((entry) => entry.version === PINNED_VERSION && entry.via === "bin"),
      `a version pin must run that version, not fail closed in this harness.\nstderr:\n${pinned.stderr}`,
    );
    assert.ok(
      pinned.executions.every((entry) => entry.version !== LATEST_VERSION),
      "pinning the package version must not execute the release tagged latest",
    );

    const runs = [];
    for (const relativePath of SKILL_FILES) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      const commands = extractFallbackCommands(source);
      const scripts = scriptsFor(commands);
      if (scripts.length === 0) {
        runs.push({ relativePath, commands, executions: [], code: 0, stdout: "", stderr: "" });
        continue;
      }
      for (const script of scripts) {
        const result = await runSkillScript(script, registryUrl);
        runs.push({ relativePath, commands, script, ...result });
      }
    }

    const compromisedRuns = runs.filter((run) =>
      run.executions.some((entry) => entry.version === LATEST_VERSION));
    assert.deepEqual(compromisedRuns.map((run) => ({
      file: run.relativePath,
      script: run.script,
      executions: run.executions,
      code: run.code,
      stderr: run.stderr,
    })), [], "following the skill ran the package currently tagged latest");
  } finally {
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
