/**
 * Spec for the unpinned @microsoft/learn-cli fallback.
 *
 * The Microsoft Learn skills tell an agent, when the Learn MCP server is
 * unavailable, to run `npx @microsoft/learn-cli` and `npm install -g
 * @microsoft/learn-cli` with no version and no integrity digest. These tests
 * execute those documented commands. They fail while the commands still run
 * whatever the registry currently serves.
 *
 * A fix has to make every documented CLI invocation finish without executing
 * that package and without leaving its files installed. npm does that for
 * `npm ci` when the lockfile digest disagrees with the registry: the tarball
 * may be fetched and is then rejected before install scripts run. A digest
 * that is only mentioned beside the command does not count. Removing the
 * fallback, or running a local binary that does not contact the registry,
 * also satisfies the tests. A version pin, dist-tag, semver range, or
 * `npm view` lookup done while the command runs still fails, because this
 * registry is the one that answers that lookup.
 *
 * Run:
 *   node --test eng/microsoft-learn-cli-unpinned.test.mjs
 *
 * npm under test is the `npm` / `npx` on PATH. The resolution and script
 * behavior these tests drive is npm 10.9.9's libnpmexec 9.0.5, pacote 19.0.2,
 * and @npmcli/arborist 8.0.5, as installed with that CLI.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const npmCli = fs.realpathSync(execFileSync("bash", ["-lc", "command -v npm"], { encoding: "utf8" }).trim());
const semver = createRequire(npmCli)("semver");

const PACKAGE = "@microsoft/learn-cli";
const LATEST = "9.9.9";
const PAYLOAD = "learn-cli-hostile-payload";

const SOURCES = [
  "skills/microsoft-code-reference/SKILL.md",
  "skills/microsoft-docs/SKILL.md",
  "skills/microsoft-skill-creator/SKILL.md",
  "skills/microsoft-skill-creator/references/skill-templates.md",
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), "learn-cli-pin-"));
const tarballDir = path.join(work, "tarballs");
fs.mkdirSync(tarballDir);

const procedures = SOURCES.flatMap((relativePath) =>
  extractProcedures(relativePath, fs.readFileSync(path.join(repoRoot, relativePath), "utf8")),
);

const hostileVersions = collectHostileVersions(procedures);
const tarballs = new Map(
  hostileVersions.map((version) => [version, packCanary(version)]),
);

let packumentHits = 0;
let tarballHits = 0;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === "GET" && isPackumentPath(pathname)) {
    packumentHits += 1;
    const body = JSON.stringify(packument(server.address().port));
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }

  const tarballVersion = tarballVersionFromPath(pathname);
  if (request.method === "GET" && tarballVersion && tarballs.has(tarballVersion)) {
    tarballHits += 1;
    const bytes = tarballs.get(tarballVersion).bytes;
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": bytes.length,
    });
    response.end(bytes);
    return;
  }

  const missing = JSON.stringify({ error: "Not found" });
  response.writeHead(404, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(missing),
  });
  response.end(missing);
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const registry = `http://127.0.0.1:${server.address().port}/`;

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

before(async () => {
  const marker = path.join(work, "probe-marker");
  resetCounters();
  const result = await runShell('npx @microsoft/learn-cli search "probe"', marker);
  assert.ok(
    packumentHits > 0,
    `probe never reached the test registry\n${formatResult(result)}`,
  );
  assert.ok(
    tarballHits > 0,
    `probe did not download the hostile tarball\n${formatResult(result)}`,
  );
  assert.match(
    readMarker(marker),
    /preinstall uid=\d+/,
    `probe did not execute the package preinstall script\n${formatResult(result)}`,
  );
  assert.match(
    readMarker(marker),
    /bin uid=\d+/,
    `probe did not execute the package bin\n${formatResult(result)}`,
  );
});

for (const [index, procedure] of procedures.entries()) {
  test(`${procedure.source}#${index} does not run registry-supplied ${PACKAGE} [${procedure.label}]`, async () => {
    const marker = path.join(work, `marker-${crypto.randomBytes(4).toString("hex")}`);
    resetCounters();
    const result = await runShell(procedure.script, marker);
    const markerText = readMarker(marker);
    const skillDir = path.dirname(path.join(repoRoot, procedure.source));
    const installed = findPayload([
      result.prefix,
      result.project,
      path.join(repoRoot, "skills"),
      ...prefixesIn(procedure.script, skillDir),
    ]);
    assert.equal(
      markerText,
      "",
      [
        `${procedure.source} executed @microsoft/learn-cli from the registry.`,
        `procedure: ${procedure.label}`,
        `script:\n${procedure.script}`,
        `marker:\n${markerText}`,
        formatResult(result),
      ].join("\n"),
    );
    assert.deepEqual(
      installed,
      [],
      [
        `${procedure.source} left the registry copy of @microsoft/learn-cli on disk.`,
        `An integrity mismatch refuses the tarball before these files exist.`,
        `A version pin alone does not, and a lookup done while the command runs still installs the registry copy.`,
        `procedure: ${procedure.label}`,
        `script:\n${procedure.script}`,
        `files:\n${installed.join("\n")}`,
        formatResult(result),
      ].join("\n"),
    );
  });
}

function extractProcedures(source, text) {
  const found = [];
  for (const section of cliSections(text)) {
    const fence = /```(?:sh|bash|shell)\r?\n([\s\S]*?)```/gi;
    for (const match of section.matchAll(fence)) {
      for (const chunk of match[1].split(/\r?\n\s*\r?\n/)) {
        const script = agentScript(chunk);
        if (script) {
          found.push({ source, script, label: firstCommand(script) });
        }
      }
    }

    const span = /`([^`\n]+)`/g;
    for (const match of section.matchAll(span)) {
      const script = agentScript(match[1]);
      if (!script || found.some((item) => item.script === script)) {
        continue;
      }
      if (!script.includes(PACKAGE) && !/(^|\s)(npx|npm)\b/.test(script)) {
        continue;
      }
      found.push({ source, script, label: firstCommand(script) });
    }
  }
  return found;
}

function cliSections(text) {
  const sections = [];
  let current = null;
  let level = 0;
  let insideShellFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (!insideShellFence && /^```(?:sh|bash|shell)\s*$/.test(line)) {
      insideShellFence = true;
      if (current) {
        current.push(line);
      }
      continue;
    }
    if (insideShellFence && line.startsWith("```")) {
      insideShellFence = false;
      if (current) {
        current.push(line);
      }
      continue;
    }
    if (!insideShellFence) {
      const heading = /^(#+)\s+(.*)$/.exec(line);
      if (heading) {
        const headingLevel = heading[1].length;
        if (current && headingLevel <= level) {
          sections.push(current.join("\n"));
          current = null;
        }
        if (!current && /CLI Alternative/i.test(heading[2])) {
          current = [];
          level = headingLevel;
          continue;
        }
      }
    }
    if (current) {
      current.push(line);
    }
  }
  if (current) {
    sections.push(current.join("\n"));
  }
  return sections;
}

function agentScript(raw) {
  return raw
    .replaceAll("<command>", "search")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function firstCommand(script) {
  const line = script.split("\n").find(Boolean) ?? script;
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

function collectHostileVersions(procedures) {
  const versions = new Set([LATEST]);
  const spec = new RegExp(`${PACKAGE.replace("/", "\\/")}(?:@([^\\s"'\`]+))?`, "g");
  for (const procedure of procedures) {
    for (const match of procedure.script.matchAll(spec)) {
      for (const version of versionsForSpec(match[1] || "*")) {
        versions.add(version);
      }
    }
    const skillDir = path.dirname(path.join(repoRoot, procedure.source));
    addVersionsFromDirectory(skillDir, versions);
    for (const prefix of prefixesIn(procedure.script, skillDir)) {
      addVersionsFromDirectory(prefix, versions);
    }
  }
  return [...versions];
}

function prefixesIn(script, skillDir) {
  const prefixes = [];
  for (const match of script.matchAll(/--prefix(?:=|\s+)(\S+)/g)) {
    const raw = match[1].replaceAll(/^['"]|['"]$/g, "");
    prefixes.push(path.resolve(skillDir, raw));
    prefixes.push(path.resolve(repoRoot, raw));
  }
  return prefixes;
}

function addVersionsFromDirectory(directory, versions) {
  if (!directory || !fs.existsSync(directory)) {
    return;
  }
  addVersionsFromPackageJson(path.join(directory, "package.json"), versions);
  addVersionsFromLock(path.join(directory, "package-lock.json"), versions);
  addVersionsFromLock(path.join(directory, "npm-shrinkwrap.json"), versions);
}

function addVersionsFromPackageJson(file, versions) {
  if (!fs.existsSync(file)) {
    return;
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const spec = json[field]?.[PACKAGE];
    if (typeof spec === "string") {
      for (const version of versionsForSpec(spec)) {
        versions.add(version);
      }
    }
  }
}

function addVersionsFromLock(file, versions) {
  if (!fs.existsSync(file)) {
    return;
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [location, meta] of Object.entries(json.packages || {})) {
    if (location.endsWith("node_modules/@microsoft/learn-cli") && meta.version) {
      versions.add(meta.version);
    }
  }
  const legacy = json.dependencies?.[PACKAGE]?.version;
  if (legacy) {
    versions.add(legacy);
  }
}

function versionsForSpec(raw) {
  if (!raw || raw === "*" || raw === "latest") {
    return [LATEST];
  }
  const exact = semver.valid(raw);
  if (exact) {
    return [exact];
  }
  if (!semver.validRange(raw)) {
    return [LATEST];
  }
  const found = new Set([LATEST]);
  const minimum = semver.minVersion(raw);
  if (minimum) {
    found.add(minimum.version);
  }
  for (const candidate of ["0.0.1", "1.0.0", "1.2.3", "1.2.999", "1.999.999", "2.0.0", "9.9.9", "99.0.0"]) {
    if (semver.satisfies(candidate, raw, { includePrerelease: false })) {
      found.add(candidate);
    }
  }
  return [...found];
}

function packCanary(version) {
  const dir = path.join(work, "src", version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: PACKAGE,
    version,
    bin: { mslearn: "bin.js" },
    scripts: { preinstall: "node preinstall.js" },
  }));
  fs.writeFileSync(path.join(dir, "preinstall.js"), `
const fs = require("node:fs");
const marker = process.env.LEARN_CLI_CANARY_MARKER;
if (marker) {
  fs.appendFileSync(marker, "preinstall uid=" + process.getuid() + " version=" + process.env.npm_package_version + "\\n");
}
`);
  fs.writeFileSync(path.join(dir, "bin.js"), `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.LEARN_CLI_CANARY_MARKER;
if (marker) {
  fs.appendFileSync(marker, "bin uid=" + process.getuid() + " argv=" + process.argv.slice(2).join(" ") + "\\n");
}
`);
  fs.writeFileSync(path.join(dir, "payload.txt"), `${PAYLOAD}\n`);
  fs.chmodSync(path.join(dir, "bin.js"), 0o755);
  const packedName = `microsoft-learn-cli-${version}.tgz`;
  const pack = runNpm("npm", ["pack", "--pack-destination", tarballDir, "--ignore-scripts"], {
    cwd: dir,
  });
  if (pack.status !== 0) {
    throw new Error(`npm pack failed for ${version}\n${pack.stdout}\n${pack.stderr}`);
  }
  const bytes = fs.readFileSync(path.join(tarballDir, packedName));
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = crypto.createHash("sha1").update(bytes).digest("hex");
  return { bytes, integrity, shasum };
}

function runNpm(command, args, options) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function packument(port) {
  const versions = {};
  for (const [version, tarball] of tarballs) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(work, "src", version, "package.json"), "utf8"),
    );
    manifest.dist = {
      tarball: `http://127.0.0.1:${port}/tarballs/learn-cli-${version}.tgz`,
      shasum: tarball.shasum,
      integrity: tarball.integrity,
    };
    versions[version] = manifest;
  }
  return {
    name: PACKAGE,
    "dist-tags": { latest: LATEST },
    versions,
  };
}

function isPackumentPath(pathname) {
  return pathname === `/${PACKAGE}` || pathname === "/@microsoft%2flearn-cli";
}

function tarballVersionFromPath(pathname) {
  const match = pathname.match(/\/learn-cli-([^/]+)\.tgz$/);
  return match?.[1] ?? null;
}

function resetCounters() {
  packumentHits = 0;
  tarballHits = 0;
}

function readMarker(marker) {
  return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
}

async function runShell(script, marker) {
  const home = fs.mkdtempSync(path.join(work, "home-"));
  const prefix = path.join(home, "prefix");
  const cache = path.join(home, "cache");
  const project = path.join(home, "project");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const userConfig = path.join(home, "user-npmrc");
  const globalConfig = path.join(home, "global-npmrc");
  fs.writeFileSync(userConfig, "");
  fs.writeFileSync(globalConfig, "");

  const child = spawn("bash", ["--noprofile", "--norc", "-s"], {
    cwd: project,
    env: {
      PATH: `${path.join(prefix, "bin")}:${process.env.PATH}`,
      HOME: home,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: "/bin/bash",
      TERM: "dumb",
      LANG: process.env.LANG || "C.UTF-8",
      TMPDIR: work,
      LEARN_CLI_CANARY_MARKER: marker,
      npm_config_registry: registry,
      npm_config_cache: cache,
      npm_config_prefix: prefix,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_ignore_scripts: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_fetch_retries: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(script);
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  return { code, stdout, stderr, prefix, project };
}

function findPayload(roots) {
  const hits = [];
  for (const root of roots) {
    walk(root, hits);
  }
  return hits;
}

function walk(directory, hits) {
  if (!fs.existsSync(directory)) {
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "cache" || entry.name === ".git") {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, hits);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes(PAYLOAD)) {
      hits.push(full);
    }
  }
}

function formatResult(result) {
  return `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}
