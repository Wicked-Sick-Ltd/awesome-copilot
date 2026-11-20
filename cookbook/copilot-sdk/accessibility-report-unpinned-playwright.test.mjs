/**
 * Spec for the accessibility-report recipes that launch a local Playwright MCP server.
 *
 * These tests fail while a recipe starts `npx` with a floating `@playwright/mcp`
 * dist-tag. They pass when every covered recipe either vendors that server or
 * launches it with an exact version and a sha512 integrity digest.
 *
 * Run:
 *   node --test cookbook/copilot-sdk/accessibility-report-unpinned-playwright.test.mjs
 *
 * Not covered here, because those copies do not reach a process launch in this run:
 *   cookbook/copilot-sdk/python/recipe/accessibility_report.py
 *   cookbook/copilot-sdk/dotnet/recipe/accessibility-report.cs
 *   the markdown, skill, and website copies of the same argument
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recipes = {
  node: path.join(here, "nodejs/recipe/accessibility-report.ts"),
  java: path.join(here, "java/recipe/AccessibilityReport.java"),
  go: path.join(here, "go/recipe/accessibility-report.go"),
};

const NODE_SDK = "@github/copilot-sdk@1.0.34";
const GO_SDK = "github.com/github/copilot-sdk/go@v0.2.2";
const GO_CLI = "@github/copilot@1.0.21";
const JAVA_SDK = "1.0.21";

test(
  "accessibility-report recipes do not execute a floating @playwright/mcp tag",
  { timeout: 600_000 },
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "a11y-mcp-"));
    const harness = await createHarness(work);
    const failures = [];
    try {
      await assertHarnessExecutesLatest(harness);
      const nodeRuntime = await installNodeSdk(work);
      const goCli = await installGoCli(work);
      const goToolchain = await ensureGo(work);

      const cases = [
        ["node", () => runNode(harness, nodeRuntime)],
        ["java", () => runJava(harness, nodeRuntime.cliPath)],
        ["go", () => runGo(harness, goToolchain, goCli)],
      ];
      for (const [name, run] of cases) {
        const outcome = await run();
        const problem = problemWith(name, outcome);
        if (problem) failures.push(problem);
      }
    } finally {
      await harness.close();
    }
    assert.deepEqual(failures, []);
  },
);

function problemWith(name, outcome) {
  const problems = [];
  if (!outcome.stdout.includes("Analyzing:")) {
    problems.push(
      `${name} did not reach session setup.\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    );
  }
  if (outcome.markerWritten) {
    problems.push(
      `${name} executed the package currently tagged @playwright/mcp@latest as the current user.\n${outcome.marker}`,
    );
  }
  for (const line of outcome.invocations) {
    if (!mentionsPlaywrightMcp(line)) continue;
    if (!isExactPinnedInvocation(line)) {
      problems.push(
        `${name} launched @playwright/mcp without an exact version and sha512 integrity: ${line}`,
      );
    }
  }
  return problems.length === 0 ? "" : problems.join("\n");
}

function mentionsPlaywrightMcp(line) {
  return line.includes("@playwright/mcp") || line.includes("playwright/mcp");
}

function isExactPinnedInvocation(line) {
  const exact = /@playwright\/mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\s|$)/;
  const integrity = /sha512-[A-Za-z0-9+/]{40,}={0,2}/;
  const floating = /@playwright\/mcp(?:@(?:latest|next|\*|[^0-9\s][^\s]*)?)?(?:\s|$)/;
  return exact.test(line) && integrity.test(line) && !floating.test(line);
}

async function createHarness(work) {
  const pkgDir = path.join(work, "pkg");
  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "@playwright/mcp",
        version: "9.9.9",
        bin: { "playwright-mcp": "./bin/run.js" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(pkgDir, "bin/run.js"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.ACCESSIBILITY_MCP_MARKER;
if (marker) {
  fs.writeFileSync(marker, JSON.stringify({ argv: process.argv, uid: process.getuid() }));
}
setInterval(() => {}, 1000);
`,
  );
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", work], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout);
  }
  const tarballName = JSON.parse(packed.stdout)[0].filename;
  const tarballPath = path.join(work, tarballName);
  const tarball = fs.readFileSync(tarballPath);
  const integrity =
    "sha512-" + createHash("sha512").update(tarball).digest("base64");
  const shasum = createHash("sha1").update(tarball).digest("hex");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/@playwright%2fmcp" || url.pathname === "/@playwright/mcp") {
      const port = server.address().port;
      const body = {
        name: "@playwright/mcp",
        "dist-tags": { latest: "9.9.9" },
        versions: {
          "9.9.9": {
            name: "@playwright/mcp",
            version: "9.9.9",
            bin: { "playwright-mcp": "./bin/run.js" },
            dist: {
              tarball: `http://127.0.0.1:${port}/@playwright/mcp/-/mcp-9.9.9.tgz`,
              shasum,
              integrity,
            },
          },
        },
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname.endsWith("/mcp-9.9.9.tgz")) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(tarball);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const binDir = path.join(work, "bin");
  fs.mkdirSync(binDir);
  const realNpx = spawnSync("which", ["npx"], { encoding: "utf8" }).stdout.trim();
  if (!realNpx) throw new Error("npx is not on PATH");
  const wrapper = path.join(binDir, "npx");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
printf '%s\\n' "$*" >> "\${ACCESSIBILITY_NPX_LOG:?}"
export NPM_CONFIG_REGISTRY="\${ACCESSIBILITY_NPM_REGISTRY:?}"
export npm_config_yes=true
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -v '^${binDir}$' | paste -sd: -)
export PATH
exec ${JSON.stringify(realNpx)} "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);

  return {
    registry,
    binDir,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertHarnessExecutesLatest(harness) {
  const marker = path.join(harness.binDir, "harness-marker.json");
  const log = path.join(harness.binDir, "harness-npx.log");
  const child = spawn(path.join(harness.binDir, "npx"), ["@playwright/mcp@latest"], {
    env: harnessEnv(harness, marker, log),
    stdio: "ignore",
  });
  const wrote = await waitForFile(marker, 20_000);
  child.kill("SIGKILL");
  assert.equal(wrote, true, "local registry did not execute @playwright/mcp@latest");
  fs.rmSync(marker, { force: true });
}

function harnessEnv(harness, marker, log, extra = {}) {
  return {
    ...process.env,
    PATH: `${harness.binDir}:${process.env.PATH}`,
    ACCESSIBILITY_MCP_MARKER: marker,
    ACCESSIBILITY_NPX_LOG: log,
    ACCESSIBILITY_NPM_REGISTRY: harness.registry,
    NPM_CONFIG_REGISTRY: harness.registry,
    npm_config_yes: "true",
    ...extra,
  };
}

async function installNodeSdk(work) {
  const dir = path.join(work, "node-sdk");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "a11y-sdk-host", private: true }),
  );
  const installed = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--omit=dev", NODE_SDK],
    { cwd: dir, encoding: "utf8" },
  );
  if (installed.status !== 0) {
    throw new Error(installed.stderr || installed.stdout);
  }
  const cliPath = path.join(
    dir,
    "node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime",
  );
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Node SDK runtime is missing at ${cliPath}`);
  }
  return { dir, cliPath };
}

async function installGoCli(work) {
  const dir = path.join(work, "go-cli");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "a11y-go-cli", private: true }),
  );
  const installed = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", GO_CLI],
    { cwd: dir, encoding: "utf8" },
  );
  if (installed.status !== 0) {
    throw new Error(installed.stderr || installed.stdout);
  }
  const cliPath = path.join(dir, "node_modules/@github/copilot-linux-x64/copilot");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Go-era Copilot CLI is missing at ${cliPath}`);
  }
  return cliPath;
}

async function ensureGo(work) {
  const probe = spawnSync("go", ["version"], { encoding: "utf8" });
  const version = `${probe.stdout ?? ""} ${probe.stderr ?? ""}`;
  if (probe.status === 0 && /go1\.(2[4-9]|[3-9]\d)/.test(version)) {
    return "go";
  }
  const dest = path.join(work, "go-toolchain");
  fs.mkdirSync(dest);
  const archive = path.join(work, "go.tgz");
  const response = await fetch("https://go.dev/dl/go1.24.11.linux-amd64.tar.gz");
  if (!response.ok) {
    throw new Error(`failed to download Go toolchain: ${response.status}`);
  }
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const extracted = spawnSync("tar", ["-C", dest, "-xzf", archive], { encoding: "utf8" });
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr || "failed to extract Go toolchain");
  }
  return path.join(dest, "go/bin/go");
}

async function runNode(harness, sdk) {
  const recipeDir = path.dirname(recipes.node);
  const link = path.join(recipeDir, "node_modules/@github/copilot-sdk");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(sdk.dir, "node_modules/@github/copilot-sdk"), link);
  try {
    return await runCommand(
      harness,
      process.execPath,
      ["--experimental-strip-types", recipes.node],
      recipeDir,
    );
  } finally {
    fs.rmSync(path.join(recipeDir, "node_modules"), { recursive: true, force: true });
  }
}

async function runJava(harness, cliPath) {
  const lib = path.join(path.dirname(harness.binDir), "java-lib");
  const out = path.join(path.dirname(harness.binDir), "java-out");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const jars = [
    `https://repo1.maven.org/maven2/com/github/copilot-sdk-java/${JAVA_SDK}/copilot-sdk-java-${JAVA_SDK}.jar`,
    "https://repo1.maven.org/maven2/com/fasterxml/jackson/core/jackson-databind/2.22.3/jackson-databind-2.22.3.jar",
    "https://repo1.maven.org/maven2/com/fasterxml/jackson/core/jackson-core/2.22.3/jackson-core-2.22.3.jar",
    "https://repo1.maven.org/maven2/com/fasterxml/jackson/core/jackson-annotations/2.22/jackson-annotations-2.22.jar",
    "https://repo1.maven.org/maven2/com/fasterxml/jackson/datatype/jackson-datatype-jsr310/2.22.3/jackson-datatype-jsr310-2.22.3.jar",
  ];
  for (const url of jars) {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to download ${url}: ${response.status}`);
    fs.writeFileSync(path.join(lib, name), Buffer.from(await response.arrayBuffer()));
  }
  const classpath = `${out}${path.delimiter}${lib}${path.sep}*`;
  const compiled = spawnSync(
    "javac",
    ["-proc:none", "-cp", `${lib}${path.sep}*`, "-d", out, recipes.java],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) {
    throw new Error(compiled.stderr || compiled.stdout);
  }
  return runCommand(harness, "java", ["-cp", classpath, "AccessibilityReport"], out, {
    COPILOT_CLI_PATH: cliPath,
  });
}

async function runGo(harness, goBin, cliPath) {
  const dir = path.join(path.dirname(harness.binDir), "go-recipe");
  fs.mkdirSync(dir);
  fs.copyFileSync(recipes.go, path.join(dir, "accessibility-report.go"));
  const env = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOPROXY: "https://proxy.golang.org,direct",
  };
  const init = spawnSync(goBin, ["mod", "init", "example.com/accessibility-report"], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  const got = spawnSync(goBin, ["get", GO_SDK], { cwd: dir, env, encoding: "utf8" });
  if (got.status !== 0) throw new Error(got.stderr || got.stdout);
  const built = spawnSync(goBin, ["build", "-o", "accessibility-report", "."], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(built.stderr || built.stdout);
  return runCommand(harness, path.join(dir, "accessibility-report"), [], dir, {
    COPILOT_CLI_PATH: cliPath,
  });
}

function runCommand(harness, command, args, cwd, extra = {}) {
  const marker = path.join(
    harness.binDir,
    `marker-${path.basename(command)}-${process.hrtime.bigint()}.json`,
  );
  const log = `${marker}.log`;
  fs.writeFileSync(log, "");
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: harnessEnv(harness, marker, log, extra),
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
    child.stdin.end("https://example.com\n");
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      if (fs.existsSync(marker) || elapsed > 25_000) {
        clearInterval(timer);
        child.kill("SIGKILL");
      }
    }, 200);
    child.on("exit", () => {
      clearInterval(timer);
      const markerWritten = fs.existsSync(marker);
      resolve({
        stdout,
        stderr,
        markerWritten,
        marker: markerWritten ? fs.readFileSync(marker, "utf8") : "",
        invocations: fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
      });
    });
  });
}

function waitForFile(file, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}
