import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.join(here, "SKILL.md");

// Names the published packages read from the process environment.
// @transloadit/mcp-server@0.8.9 dist/cli.js reads TRANSLOADIT_KEY and TRANSLOADIT_SECRET.
// @transloadit/node@6.9.1 dist/cli/helpers.js reads the same names from process.env.
const CREDENTIAL_ENV_NAMES = [
  "TRANSLOADIT_KEY",
  "TRANSLOADIT_SECRET",
  "TRANSLOADIT_AUTH_KEY",
  "TRANSLOADIT_AUTH_SECRET",
];

const PLACEHOLDER_CREDENTIALS = {
  TRANSLOADIT_KEY: "placeholder-auth-key",
  TRANSLOADIT_SECRET: "placeholder-auth-secret",
  TRANSLOADIT_AUTH_KEY: "placeholder-auth-key",
  TRANSLOADIT_AUTH_SECRET: "placeholder-auth-secret",
};

const REPLACED_VERSION = "99.99.99";

function npmPackageRoot() {
  const npxPath = realpathSync(execFileSync("bash", ["-lc", "command -v npx"], { encoding: "utf8" }).trim());
  const text = readFileSync(npxPath, "utf8");
  const wrapper = text.match(/lib\/node_modules\/npm\/bin\/npx-cli\.js/);
  if (wrapper) {
    return path.resolve(path.dirname(npxPath), "lib/node_modules/npm");
  }
  return path.resolve(path.dirname(npxPath), "..");
}

const requireFromNpm = createRequire(path.join(npmPackageRoot(), "package.json"));
const npa = requireFromNpm("npm-package-arg");
const semver = requireFromNpm("semver");

const BIN_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const version = require("./package.json").version;
const names = String(process.env.CREDENTIAL_ENV_NAMES || "").split(",").filter(Boolean);
const credentialPresent = names.some((name) => {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
});
fs.appendFileSync(process.env.LAUNCH_RECORD, JSON.stringify({ version, credentialPresent }) + "\\n");
`;

// Bin keys from the published manifests. libnpmexec getBinFromManifest
// (libnpmexec@10.3.4 lib/get-bin-from-manifest.js lines 6-7) runs the only
// bin key. @transloadit/node's unscoped name is "node", and a bin with that
// key shadows the real node binary on PATH.
const PUBLISHED_BIN_NAMES = {
  "@transloadit/node": "transloadit",
  "@transloadit/mcp-server": "transloadit-mcp",
};

function extractLaunches(markdown) {
  const launches = [];
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(markdown))) {
    const lang = match[1].trim().toLowerCase();
    const body = match[2];
    if (lang !== "json" && lang !== "jsonc") {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const servers = parsed.servers || parsed.mcpServers;
    if (!servers || typeof servers !== "object") {
      continue;
    }
    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server.command !== "string") {
        continue;
      }
      launches.push({
        id: `mcp:${name}`,
        kind: "mcp",
        command: server.command,
        args: Array.isArray(server.args) ? server.args.map(String) : [],
        env: server.env && typeof server.env === "object" ? { ...server.env } : {},
      });
    }
  }

  const prose = markdown
    .replace(/```json[^\n]*\n[\s\S]*?```/g, "")
    .replace(/```jsonc[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\\\r?\n/g, " ");
  const withoutFences = prose.replace(/```[^\n]*\n/g, "").replace(/```/g, "");
  for (const line of withoutFences.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^(npx|npm)\b/.test(trimmed)) {
      continue;
    }
    const tokens = tokenize(trimmed);
    if (tokens[0] !== "npx" && !(tokens[0] === "npm" && tokens[1] === "exec")) {
      continue;
    }
    launches.push({
      id: `cli:${tokens.slice(0, 3).join(" ")}`,
      kind: "cli",
      command: tokens[0],
      args: tokens.slice(1),
      env: {},
    });
  }
  return launches;
}

function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(line))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function packageSpecs(command, args) {
  const specs = [];
  const argv = command === "npm" && args[0] === "exec" ? args.slice(1) : args;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      break;
    }
    if (arg === "--package" || arg === "-p") {
      specs.push(argv[++i]);
      continue;
    }
    if (arg.startsWith("--package=")) {
      specs.push(arg.slice("--package=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    specs.push(arg);
    break;
  }
  return specs.filter(Boolean).map((spec) => npa(spec));
}

function isRegistrySpec(spec) {
  return Boolean(spec?.registry && ["version", "range", "tag", "alias"].includes(spec.type));
}

function versionsForSpec(spec) {
  if (spec.type === "version") {
    return { benign: spec.fetchSpec, floating: false };
  }
  if (spec.type === "tag" || spec.fetchSpec === "*" || spec.fetchSpec === "") {
    return { benign: "1.0.0", floating: true };
  }
  if (spec.type === "range") {
    const min = semver.minVersion(spec.fetchSpec);
    const benign = min ? min.version : "1.0.0";
    return { benign, floating: true, range: spec.fetchSpec };
  }
  return null;
}

function replacedVersionFor(plan) {
  if (!plan.floating) {
    return REPLACED_VERSION;
  }
  if (!plan.range || plan.range === "*") {
    return REPLACED_VERSION;
  }
  const candidates = ["99.99.99", "9.9.9", "2.0.0", "1.99.99", "1.0.1", "0.9.9", "0.0.2"];
  for (const candidate of candidates) {
    if (candidate !== plan.benign && semver.satisfies(candidate, plan.range, { loose: true }) && semver.gt(candidate, plan.benign)) {
      return candidate;
    }
  }
  return REPLACED_VERSION;
}

async function makeTarball(pkgName, version) {
  const root = await mkdtemp(path.join(tmpdir(), "transloadit-pkg-"));
  const pkgDir = path.join(root, "package");
  await mkdir(pkgDir);
  const binName = PUBLISHED_BIN_NAMES[pkgName] || "tool";
  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: pkgName, version, bin: { [binName]: "bin.js" } })
  );
  await writeFile(path.join(pkgDir, "bin.js"), BIN_SOURCE, { mode: 0o755 });
  const tarballPath = path.join(root, "package.tgz");
  await execFileAsync("tar", ["-czf", tarballPath, "-C", root, "package"]);
  const bytes = await readFile(tarballPath);
  await rm(root, { recursive: true, force: true });
  return {
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    binName,
  };
}

function createRegistry() {
  const tarballs = new Map();
  const published = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const parts = pathname.split("/").filter(Boolean);
    if (req.method === "POST" && pathname.includes("advisories")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (pathname === "/npm" || pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (parts.includes("-")) {
      const key = pathname;
      const tarball = tarballs.get(key);
      if (!tarball) {
        res.writeHead(404);
        res.end("missing tarball");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.bytes.length });
      res.end(tarball.bytes);
      return;
    }
    const name = parts[0]?.startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
    const entry = published.get(name);
    if (!entry) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const versions = {};
    for (const [version, meta] of entry.versions) {
      const tarballPath = `/${name}/-/${meta.binName}-${version}.tgz`;
      versions[version] = {
        name,
        version,
        _id: `${name}@${version}`,
        bin: { [meta.binName]: "bin.js" },
        dist: {
          tarball: `${entry.origin}${tarballPath}`,
          integrity: meta.integrity,
          shasum: meta.shasum,
        },
      };
      tarballs.set(tarballPath, meta);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name, "dist-tags": { latest: entry.latest }, versions }));
  });
  return {
    server,
    async listen() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address();
      this.origin = `http://127.0.0.1:${port}`;
      return this.origin;
    },
    async publish(pkgName, version, latest) {
      const meta = await makeTarball(pkgName, version);
      let entry = published.get(pkgName);
      if (!entry) {
        entry = { versions: new Map(), latest: version, origin: this.origin };
        published.set(pkgName, entry);
      }
      entry.versions.set(version, meta);
      entry.latest = latest ?? version;
      entry.origin = this.origin;
    },
    setLatest(pkgName, version) {
      published.get(pkgName).latest = version;
    },
    close() {
      server.close();
    },
  };
}

function launchEnv(base, configured) {
  // Same overlay as VS Code NodeExtHostMpcService.startNodeMpc at
  // microsoft/vscode@6e68549edb69380c9316e49df5d3795d5064a2b0
  // src/vs/workbench/api/node/extHostMcpNode.ts lines 81-99.
  // sandboxEnabled is unset, so McpSandboxService.launchInSandboxIfEnabled
  // returns the launch unchanged (mcpSandboxService.ts lines 105-149).
  // Values without ${...} are unchanged by ConfigurationResolverExpression.parse
  // (configurationResolverExpression.ts lines 141-145).
  const env = { ...base };
  for (const [key, value] of Object.entries(configured || {})) {
    if (value === null || value === undefined) {
      env[key] = undefined;
      continue;
    }
    env[key] = String(value);
  }
  return env;
}

async function runLaunch(launch, env) {
  const cwd = await mkdtemp(path.join(tmpdir(), "transloadit-cwd-"));
  const child = spawn(launch.command, launch.args, {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  await rm(cwd, { recursive: true, force: true });
  return { code, stderr };
}

async function readRecords(recordPath) {
  let text = "";
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

test("transloadit skill launches do not run a package published later or hand it credentials", { timeout: 180000 }, async () => {
  const markdown = await readFile(skillPath, "utf8");
  const launches = extractLaunches(markdown);
  assert.ok(launches.length > 0, "SKILL.md must be readable and still contain its setup launches for this check");

  const registry = createRegistry();
  const origin = await registry.listen();
  const cache = await mkdtemp(path.join(tmpdir(), "transloadit-npm-cache-"));
  const failures = [];
  try {
    for (const launch of launches) {
      await exclusive(async () => {
        const resolvesFromRegistry = launch.command === "npx" || (launch.command === "npm" && launch.args[0] === "exec");
        const specs = resolvesFromRegistry ? packageSpecs(launch.command, launch.args).filter(isRegistrySpec) : [];
        if (specs.length === 0) {
          return;
        }
        const recordPath = path.join(cache, `${launch.id.replace(/[^a-z0-9]+/gi, "-")}.ndjson`);
        // VS Code copies process.env and then overlays launch.env. This agent
        // process carries an unrelated environment large enough to make
        // /usr/bin/env fail with E2BIG, so the base here is the small set a
        // desktop Node process needs to resolve npx. Credential names are
        // added below, not copied from this process.
        const base = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USER: process.env.USER,
          LANG: process.env.LANG || "C.UTF-8",
          TMPDIR: process.env.TMPDIR || tmpdir(),
        };
        base.npm_config_registry = origin;
        base.npm_config_cache = cache;
        base.npm_config_update_notifier = "false";
        base.npm_config_fund = "false";
        base.npm_config_audit = "false";
        base.LAUNCH_RECORD = recordPath;
        base.CREDENTIAL_ENV_NAMES = CREDENTIAL_ENV_NAMES.join(",");
        // The CLI example does not set env itself. The package it names reads
        // these names from the parent environment, so the parent has placeholders.
        if (launch.kind === "cli") {
          Object.assign(base, PLACEHOLDER_CREDENTIALS);
        }
        const env = launchEnv(base, launch.env);

        for (const spec of specs) {
          const plan = versionsForSpec(spec);
          assert.ok(plan, `${launch.id} has a registry spec this harness can resolve`);
          const replaced = replacedVersionFor(plan);
          await registry.publish(spec.name, plan.benign, plan.benign);
          await registry.publish(spec.name, replaced, plan.benign);
          const first = await runLaunch(launch, env);
          const afterFirst = await readRecords(recordPath);
          assert.ok(
            afterFirst.length >= 1,
            `${launch.id} did not execute the package named in SKILL.md (exit ${first.code}). ${first.stderr.slice(-2000)}`
          );
          assert.equal(
            afterFirst.at(-1).version,
            plan.benign,
            `${launch.id} first start ran ${afterFirst.at(-1).version} instead of the version that was latest (${plan.benign})`
          );
          registry.setLatest(spec.name, replaced);
          const second = await runLaunch(launch, env);
          const afterSecond = await readRecords(recordPath);
          assert.ok(
            afterSecond.length >= 2,
            `${launch.id} did not execute on the second start (exit ${second.code}). ${second.stderr.slice(-2000)}`
          );
          const ran = afterSecond[afterSecond.length - 1];
          if (ran.version === replaced) {
            failures.push(`${launch.id} executed ${spec.name}@${replaced}, the version published after the first start`);
          }
          if (ran.credentialPresent) {
            failures.push(
              `${launch.id} executed registry-resolved ${spec.name} with credential environment names visible to that package`
            );
          }
        }
      });
    }
  } finally {
    registry.close();
    await rm(cache, { recursive: true, force: true });
  }

  assert.deepEqual(failures, []);
});
