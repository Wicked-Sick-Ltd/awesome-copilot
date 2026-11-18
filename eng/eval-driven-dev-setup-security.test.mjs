// Security regression for skills/eval-driven-dev/resources/setup.sh.
//
// Run:
//   node --test eng/eval-driven-dev-setup-security.test.mjs
//
// These tests fail while that script executes the npm package named "skills"
// from an unpinned registry publish. They pass when a substituted publish
// cannot run a lifecycle script or bin, including when a metadata lookup and
// the later install are separate requests.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setupPath = path.join(repoRoot, "skills/eval-driven-dev/resources/setup.sh");
const resourcesDir = path.dirname(setupPath);
// Fixed directories plus the Node install that is running this file. The
// child PATH is not taken from the parent environment, so the shell command
// does not depend on an environment path.
const basePath = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", path.dirname(process.execPath)].join(":");
const UNPINNED_VERSION = "9.9.9";

const packageEntry = `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.SKILLS_PACKAGE_MARKER;
if (!marker) process.exit(0);
let projectFileReadable = false;
try {
  fs.readFileSync("project-marker.txt");
  projectFileReadable = true;
} catch {}
fs.appendFileSync(marker, JSON.stringify({
  event: process.env.npm_lifecycle_event || "unknown",
  argv: process.argv.slice(2),
  projectFileReadable,
  credentialEnvPresent: Object.prototype.hasOwnProperty.call(process.env, "MODEL_API_KEY"),
}) + "\\n");
`;

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function findCommittedSkillsPins(setupText) {
  const versions = new Set();
  const integrities = new Set();
  for (const match of setupText.matchAll(/\bskills@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)) {
    versions.add(match[1]);
  }
  for (const match of setupText.matchAll(/integrity(?:=|\s+)(sha512-[A-Za-z0-9+/=]+)/g)) {
    integrities.add(match[1]);
  }
  for (const file of walkFiles(resourcesDir)) {
    if (!/\.(json|lock)$/.test(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    collectSkillsPins(parsed, null, versions, integrities);
  }
  return { versions: [...versions], integrities: [...integrities] };
}

function collectSkillsPins(value, key, versions, integrities) {
  if (!value || typeof value !== "object") return;
  const keyNamesSkills = key === "skills" || key === "node_modules/skills";
  if (value.name === "skills" || keyNamesSkills) {
    if (typeof value.version === "string") versions.add(value.version);
    if (typeof value.integrity === "string") integrities.add(value.integrity);
  }
  for (const [childKey, child] of Object.entries(value)) {
    if (child && typeof child === "object") {
      collectSkillsPins(child, childKey, versions, integrities);
    }
  }
}

function extractSkillsCommands(setupText) {
  return setupText
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .split(/&&|\|\||\n|;/)
    .map((part) => part.trim())
    .filter((part) => /(?:^|\s)(?:npx|npm)\b/.test(part) && /\bskills\b/.test(part));
}

async function packSkills(version, workRoot) {
  const pkgDir = path.join(workRoot, `pkg-${version}`);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
    name: "skills",
    version,
    bin: { skills: "run.js" },
    scripts: { preinstall: "node run.js" },
  }));
  fs.writeFileSync(path.join(pkgDir, "run.js"), packageEntry);
  fs.chmodSync(path.join(pkgDir, "run.js"), 0o755);
  const output = await runNpm(["pack", "--pack-destination", workRoot, "--json"], pkgDir);
  const packed = JSON.parse(output);
  const tarballPath = path.join(workRoot, packed[0].filename);
  const tarball = fs.readFileSync(tarballPath);
  return {
    version,
    tarball,
    integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`,
    shasum: crypto.createHash("sha1").update(tarball).digest("hex"),
  };
}

function runNpm(args, cwd) {
  const child = spawn("npm", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: basePath,
      HOME: cwd,
      TMPDIR: cwd,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`npm ${args.join(" ")} failed: ${stderr}`));
      else resolve(stdout);
    });
  });
}

async function startRegistry(packages, pins) {
  const byVersion = new Map(packages.map((pkg) => [pkg.version, pkg]));
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const command = req.headers["npm-command"] || "";
    requests.push({ method: req.method, url, command });
    if (url !== "/skills") {
      if (url.startsWith("/tarballs/")) {
        const version = decodeURIComponent(url.slice("/tarballs/".length).replace(/\.tgz$/, ""));
        const pkg = byVersion.get(version);
        if (pkg) {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(pkg.tarball);
          return;
        }
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // A metadata lookup (npm view, or a client that is not npm exec/install/ci)
    // is answered with the committed digest when one exists. The install path
    // is answered with the substituted publish, whose digest is its own.
    const metadataOnly = command === "view" || command === "";
    const versions = {};
    for (const pkg of packages) {
      const advertisePinnedDigest = metadataOnly && pins.integrities.length > 0
        && (pins.versions.length === 0 || pins.versions.includes(pkg.version));
      versions[pkg.version] = {
        name: "skills",
        version: pkg.version,
        bin: { skills: "run.js" },
        scripts: { preinstall: "node run.js" },
        dist: {
          tarball: `http://127.0.0.1:${server.address().port}/tarballs/${encodeURIComponent(pkg.version)}.tgz`,
          integrity: advertisePinnedDigest ? pins.integrities[0] : pkg.integrity,
          shasum: pkg.shasum,
        },
      };
    }
    const body = JSON.stringify({
      name: "skills",
      "dist-tags": { latest: UNPINNED_VERSION },
      versions,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port,
    requests,
  };
}

function writeStubs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["python", "python3", "pip", "pip3", "uv", "poetry"]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(file, 0o755);
  }
}

async function runCommand(command, registryPort, workRoot) {
  const project = path.join(workRoot, "project");
  const cache = path.join(workRoot, "npm-cache");
  const prefix = path.join(workRoot, "npm-prefix");
  const stubs = path.join(workRoot, "stubs");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  writeStubs(stubs);
  fs.writeFileSync(path.join(project, "project-marker.txt"), "project-file-visible");
  const marker = path.join(workRoot, "marker.txt");
  const child = spawn("bash", ["-c", command], {
    cwd: project,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${stubs}:${basePath}`,
      HOME: workRoot,
      TMPDIR: workRoot,
      npm_config_registry: `http://127.0.0.1:${registryPort}/`,
      npm_config_cache: cache,
      npm_config_prefix: prefix,
      SKILLS_PACKAGE_MARKER: marker,
      MODEL_API_KEY: "placeholder-not-a-secret",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", () => {});
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, 30000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  const events = fs.existsSync(marker)
    ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { code, signal, stderr, events };
}

function executionMessage(events) {
  return `substituted skills package executed before any digest mismatch could reject it: ${JSON.stringify(events)}`;
}

async function withRegistry(pins, versions, fn) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-setup-"));
  const uniqueVersions = [...new Set(versions)];
  const packages = [];
  for (const version of uniqueVersions) {
    packages.push(await packSkills(version, workRoot));
  }
  const registry = await startRegistry(packages, pins);
  try {
    return await fn(registry, workRoot);
  } finally {
    registry.server.close();
  }
}

test("setup.sh does not execute a substituted skills publish", { timeout: 60000 }, async () => {
  const setupText = fs.readFileSync(setupPath, "utf8");
  const pins = findCommittedSkillsPins(setupText);
  const versions = [UNPINNED_VERSION, ...pins.versions];
  await withRegistry(pins, versions, async (registry, workRoot) => {
    const result = await runCommand(`bash ${JSON.stringify(setupPath)}`, registry.port, workRoot);
    assert.deepEqual(result.events, [], executionMessage(result.events));
    const commands = extractSkillsCommands(setupText);
    const resolvedSkills = registry.requests.some((request) => request.url === "/skills");
    if (commands.length > 0 && !resolvedSkills) {
      assert.fail(`setup.sh still invokes skills, but the registry was not contacted: ${result.stderr.slice(-1500)}`);
    }
  });
});

test("each skills command in setup.sh rejects a substituted publish before it runs", { timeout: 60000 }, async () => {
  const setupText = fs.readFileSync(setupPath, "utf8");
  const commands = extractSkillsCommands(setupText);
  const pins = findCommittedSkillsPins(setupText);
  const versions = [UNPINNED_VERSION, ...pins.versions];
  const failures = [];
  for (const command of commands) {
    await withRegistry(pins, versions, async (registry, workRoot) => {
      const result = await runCommand(command, registry.port, workRoot);
      const resolvedSkills = registry.requests.some((request) => request.url === "/skills");
      if (result.events.length > 0) {
        failures.push(`${command}\n${executionMessage(result.events)}`);
      } else if (!resolvedSkills) {
        failures.push(`${command} did not resolve the skills package: ${result.stderr.slice(-1500)}`);
      }
    });
  }
  assert.deepEqual(failures, []);
});
