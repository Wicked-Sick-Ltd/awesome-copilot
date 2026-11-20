import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(repoRoot, "skills", "workiq-copilot");
const skillText = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const isWindows = process.platform === "win32";

function codeSpans(markdown) {
  const spans = [];
  const withoutFences = markdown.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    spans.push(...body.split("\n").map((line) => line.trim()).filter(Boolean));
    return "";
  });
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    spans.push(match[1].trim());
  }
  return spans;
}

const shellAcquisition = /^(npm|npx|pnpm|yarn|bunx?|node)\s/;
const pluginAcquisition = /(^|\s)\/?plugins?\s+(install|marketplace\s+add)\b|copilot\s+plugins?\s+install\b/;

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runShell(commandLine, options) {
  return run(commandLine, [], { ...options, shell: true });
}

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function packPackage(root, name, version, bin) {
  const dir = fs.mkdtempSync(path.join(root, "pkg-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "workiq.js"), bin);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      version,
      bin: { workiq: "bin/workiq.js" },
      scripts: { postinstall: "node bin/workiq.js postinstall" },
    })
  );
  const out = fs.mkdtempSync(path.join(root, "tgz-"));
  const npm = isWindows ? "npm.cmd" : "npm";
  const result = await run(npm, ["pack", "--ignore-scripts", "--pack-destination", out], {
    cwd: dir,
    shell: isWindows,
  });
  assert.equal(result.code, 0, result.stderr);
  const [file] = fs.readdirSync(out).filter((entry) => entry.endsWith(".tgz"));
  return fs.readFileSync(path.join(out, file));
}

const maliciousBin = `#!/usr/bin/env node
require("fs").writeFileSync(process.env.WORKIQ_TEST_MARKER, "replacement publish executed: " + process.argv.slice(2).join(" "));
`;

const benignBin = `#!/usr/bin/env node
console.log("benign workiq " + process.argv.slice(2).join(" "));
`;

async function startRegistry(packages) {
  const tarballs = new Map();
  const server = http.createServer((req, res) => {
    server.requests.push(req.url);
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url.startsWith("/-/tarballs/")) {
      const bytes = tarballs.get(url);
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
      return;
    }
    const pkg = packages[url.slice(1)];
    if (!pkg) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    const { port } = server.address();
    const versions = {};
    for (const [version, bytes] of Object.entries(pkg.versions)) {
      const tarballPath = `/-/tarballs/${pkg.name}/${version}.tgz`;
      tarballs.set(tarballPath, bytes);
      versions[version] = {
        name: pkg.name,
        version,
        bin: { workiq: "bin/workiq.js" },
        scripts: { postinstall: "node bin/workiq.js postinstall" },
        dist: {
          tarball: `http://127.0.0.1:${port}${tarballPath}`,
          integrity: integrityOf(bytes),
          shasum: createHash("sha1").update(bytes).digest("hex"),
        },
      };
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name: pkg.name, "dist-tags": { latest: pkg.latest }, versions }));
  });
  server.requests = [];
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function sandboxEnv(root, registryPort) {
  const home = path.join(root, "home");
  const prefix = path.join(root, "prefix");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(root, "user-npmrc"), "");
  fs.writeFileSync(path.join(root, "global-npmrc"), "");
  const binDir = isWindows ? prefix : path.join(prefix, "bin");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_")) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    npm_config_registry: `http://127.0.0.1:${registryPort}/`,
    npm_config_prefix: prefix,
    npm_config_cache: path.join(root, "cache"),
    npm_config_userconfig: path.join(root, "user-npmrc"),
    npm_config_globalconfig: path.join(root, "global-npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    WORKIQ_TEST_MARKER: path.join(root, "marker"),
  };
}

async function followSkillAgainst(t, registryFor, commandLine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-skill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startRegistry(await registryFor(root));
  t.after(() => server.close());
  const env = sandboxEnv(root, server.address().port);

  const install = await runShell(commandLine, { cwd: skillDir, env });
  // The skill's pre-flight step runs the installed binary.
  await runShell("workiq version", { cwd: root, env, timeout: 30_000 });

  const marker = env.WORKIQ_TEST_MARKER;
  return {
    install,
    requests: server.requests,
    executed: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
  };
}

const acquisitionCommands = codeSpans(skillText).filter((span) => shellAcquisition.test(span));

test("the WorkIQ skill still tells the agent how to get WorkIQ", () => {
  assert.ok(acquisitionCommands.length > 0, "expected at least one install command in SKILL.md");
});

test("the WorkIQ skill does not have the agent install a floating marketplace plugin", () => {
  const pluginCommands = codeSpans(skillText).filter((span) => pluginAcquisition.test(span));
  assert.deepEqual(pluginCommands, []);
});

test("no skill has the agent install a floating marketplace plugin", () => {
  const skillsDir = path.join(repoRoot, "skills");
  const found = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    for (const span of codeSpans(fs.readFileSync(file, "utf8"))) {
      if (pluginAcquisition.test(span)) found.push(`${entry}: ${span}`);
    }
  }
  assert.deepEqual(found, []);
});

for (const commandLine of acquisitionCommands) {
  test(`\`${commandLine}\` from the WorkIQ skill does not run a later publish`, async (t) => {
    const { install, requests, executed } = await followSkillAgainst(
      t,
      async (root) => ({
        "@microsoft/workiq": {
          name: "@microsoft/workiq",
          latest: "1.0.2",
          versions: {
            "1.0.2": await packPackage(root, "@microsoft/workiq", "1.0.2", maliciousBin),
          },
        },
      }),
      commandLine
    );
    assert.ok(requests.length > 0, `${commandLine} never reached the registry\n${install.stderr}`);
    assert.equal(executed, null, `${commandLine}\n${install.stdout}\n${install.stderr}`);
  });

  test(`\`${commandLine}\` from the WorkIQ skill does not run replaced bytes for the pinned version`, async (t) => {
    const { install, requests, executed } = await followSkillAgainst(
      t,
      async (root) => {
        const versions = {};
        for (const version of ["1.0.1", "1.0.2"]) {
          versions[version] = await packPackage(root, "@microsoft/workiq", version, maliciousBin);
        }
        return {
          "@microsoft/workiq": { name: "@microsoft/workiq", latest: "1.0.2", versions },
        };
      },
      commandLine
    );
    assert.ok(requests.length > 0, `${commandLine} never reached the registry\n${install.stderr}`);
    assert.equal(executed, null, `${commandLine}\n${install.stdout}\n${install.stderr}`);
  });
}

test("the bundled installer installs exactly the bytes whose integrity it was given", async (t) => {
  const { installVerifiedPackage } = await import(
    pathToFileURL(path.join(skillDir, "scripts", "install-workiq.mjs")).href
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-skill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const benign = await packPackage(root, "@example/workiq", "3.0.0", benignBin);
  const server = await startRegistry({
    "@example/workiq": {
      name: "@example/workiq",
      latest: "3.0.0",
      versions: { "3.0.0": benign },
    },
  });
  t.after(() => server.close());
  const env = sandboxEnv(root, server.address().port);

  await installVerifiedPackage({
    name: "@example/workiq",
    version: "3.0.0",
    integrity: integrityOf(benign),
    env,
  });
  const result = await runShell("workiq version", { cwd: root, env, timeout: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /benign workiq version/);
  assert.equal(fs.existsSync(env.WORKIQ_TEST_MARKER), false);

  await assert.rejects(
    installVerifiedPackage({
      name: "@example/workiq",
      version: "3.0.0",
      integrity: integrityOf(Buffer.from("different bytes")),
      env,
    }),
    /integrity/
  );
});
