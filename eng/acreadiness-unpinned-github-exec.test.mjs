import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// npm 10.9.9 (the npm shipped with the Node on PATH) treats a git committish
// as an immutable commit only when it matches this pattern. Anything else,
// including a missing committish or a branch name, resolves to a ref and
// therefore moves when that ref moves.
// pacote 19.0.2 lib/git.js: `const hashre = /^[a-f0-9]{40}$/`
const FULL_COMMIT = /^[a-f0-9]{40}$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

const requiredCommands = [
  { file: "skills/acreadiness-assess/SKILL.md", minimum: 1 },
  { file: "agents/ai-readiness-reporter.agent.md", minimum: 1 },
  { file: "skills/acreadiness-generate-instructions/SKILL.md", minimum: 1 },
  { file: "skills/acreadiness-policy/SKILL.md", minimum: 2 },
];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const npa = loadNpa();

function loadNpa() {
  const npmBin = spawnSync("which", ["npm"], { encoding: "utf8" });
  assert.equal(npmBin.status, 0, npmBin.stderr);
  const npmEntry = fs.realpathSync(npmBin.stdout.trim());
  const npmDir = path.resolve(path.dirname(npmEntry), "..");
  const require = createRequire(path.join(npmDir, "package.json"));
  return require("npm-package-arg");
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (/\.(md|mjs|js|cjs|json|yml|yaml|sh|txt)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function cleanToken(token) {
  return token.replace(/^[`'"([{]+/, "").replace(/[`'")\]},.;:]+$/g, "");
}

function invocationsInFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const tokens = lines[index].trim().split(/\s+/).filter(Boolean).map(cleanToken);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const isNpx = token === "npx";
      const isNpmExec = token === "exec" && tokens[i - 1] === "npm";
      if (!isNpx && !isNpmExec) {
        continue;
      }
      let j = i + 1;
      while (j < tokens.length && tokens[j].startsWith("-")) {
        const flag = tokens[j];
        j += 1;
        if (["-c", "--call", "--package", "-p", "--cache"].includes(flag) && j < tokens.length) {
          j += 1;
        }
      }
      if (j >= tokens.length || !tokens[j].startsWith("github:microsoft/agentrc")) {
        continue;
      }
      found.push({
        file: path.relative(repoRoot, file),
        line: index + 1,
        spec: tokens[j],
        args: tokens.slice(j + 1),
      });
    }
  }
  return found;
}

function productCommands() {
  const files = walk(repoRoot, []);
  const commands = [];
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    if (relative.endsWith(".test.mjs") || relative.endsWith(".test.js")) {
      continue;
    }
    commands.push(...invocationsInFile(file));
  }
  return commands;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${cmd} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function binSource(commitLabel) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
let workspace = null;
try {
  workspace = fs.readFileSync("repo-marker.txt", "utf8");
} catch (error) {
  workspace = error.code || String(error);
}
const report = {
  commitLabel: ${JSON.stringify(commitLabel)},
  cwd: process.cwd(),
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  argv: process.argv.slice(2),
  sawSentinel: process.env.ACREADINESS_SENTINEL === "placeholder-not-a-secret",
  workspace,
};
fs.writeFileSync(process.env.ACREADINESS_RESULT, JSON.stringify(report));
`;
}

function buildFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acreadiness-npx-"));
  tempDirs.push(tmp);
  const packageRepo = path.join(tmp, "agentrc");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(packageRepo);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "repo-marker.txt"), "workspace-marker\n");
  fs.writeFileSync(
    path.join(packageRepo, "package.json"),
    `${JSON.stringify({
      name: "agentrc",
      version: "1.0.0",
      bin: { agentrc: "./bin.js" },
    }, null, 2)}\n`,
  );

  const git = (args) => run("git", args, { cwd: packageRepo });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "fixture@example.com"]);
  git(["config", "user.name", "fixture"]);
  writeExecutable(path.join(packageRepo, "bin.js"), binSource("pinned"));
  git(["add", "package.json", "bin.js"]);
  git(["commit", "-m", "pinned"]);
  const pinnedSha = git(["rev-parse", "HEAD"]).trim();
  assert.match(pinnedSha, FULL_COMMIT);

  writeExecutable(path.join(packageRepo, "bin.js"), binSource("head"));
  git(["add", "bin.js"]);
  git(["commit", "-m", "move default branch"]);
  const headSha = git(["rev-parse", "HEAD"]).trim();
  assert.match(headSha, FULL_COMMIT);
  assert.notEqual(headSha, pinnedSha);

  const gitconfig = path.join(tmp, "gitconfig");
  const prefix = packageRepo.endsWith("/") ? packageRepo : `${packageRepo}/`;
  const insteadOf = [
    "https://github.com/microsoft/agentrc.git",
    "https://github.com/microsoft/agentrc/",
    "ssh://git@github.com/microsoft/agentrc.git",
    "ssh://git@github.com/microsoft/agentrc/",
    "git://github.com/microsoft/agentrc.git",
    "git://github.com/microsoft/agentrc/",
    "git@github.com:microsoft/agentrc.git",
    "git@github.com:microsoft/agentrc",
  ];
  fs.writeFileSync(
    gitconfig,
    insteadOf.map((remote) => `[url "${prefix}"]\n\tinsteadOf = ${remote}\n`).join(""),
  );
  const gitEnv = gitChildEnv(gitconfig);
  const listed = run(
    "git",
    ["ls-remote", "https://github.com/microsoft/agentrc.git", "HEAD"],
    { env: gitEnv },
  );
  assert.match(
    listed,
    new RegExp(`^${headSha}\\s+HEAD$`, "m"),
    "git rewrite did not point github:microsoft/agentrc at the local fixture",
  );

  return { tmp, workspace, gitconfig, pinnedSha, headSha };
}

function gitChildEnv(gitconfig) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
  };
}

let executionCounter = 0;

function execute(command, fixture) {
  const id = executionCounter;
  executionCounter += 1;
  const resultPath = path.join(fixture.tmp, `result-${id}.json`);
  const cacheDir = path.join(fixture.tmp, `npm-cache-${id}`);
  fs.mkdirSync(cacheDir);
  const env = {
    ...gitChildEnv(fixture.gitconfig),
    ACREADINESS_SENTINEL: "placeholder-not-a-secret",
    ACREADINESS_RESULT: resultPath,
    npm_config_cache: cacheDir,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_fetch_retries: "0",
  };
  const args = ["-y", command.spec, ...command.args];
  const output = spawnSync("npx", args, {
    cwd: fixture.workspace,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    output.status,
    0,
    `npx ${args.join(" ")} failed (${output.status}): ${output.stderr || output.stdout}`,
  );
  assert.equal(fs.existsSync(resultPath), true, "package bin did not run");
  return JSON.parse(fs.readFileSync(resultPath, "utf8"));
}

function assertExecutesPinnedCommit(command, fixture) {
  const parsed = npa(command.spec);
  assert.equal(parsed.type, "git", `${command.file}:${command.line} is not a git specifier`);
  assert.equal(parsed.hosted && parsed.hosted.type, "github");
  const committish = parsed.gitCommittish;
  const isFullSha = typeof committish === "string" && FULL_COMMIT.test(committish);

  if (!isFullSha) {
    const outcome = execute(command, fixture);
    assert.equal(outcome.cwd, fixture.workspace);
    assert.equal(outcome.uid, process.getuid());
    assert.equal(outcome.workspace, "workspace-marker\n");
    assert.equal(outcome.sawSentinel, true);
    assert.equal(outcome.argv[0], command.args[0]);
    assert.equal(outcome.commitLabel, "head");
    assert.equal(
      outcome.commitLabel,
      "pinned",
      `${command.file}:${command.line} ran npx ${command.spec} ` +
        `(gitCommittish=${committish ?? "none"}) and executed the default branch ` +
        `${fixture.headSha} after it moved past ${fixture.pinnedSha}. ` +
        `cwd=${outcome.cwd} uid=${outcome.uid} workspace=${JSON.stringify(outcome.workspace)} ` +
        `argv=${JSON.stringify(outcome.argv)} sawSentinel=${outcome.sawSentinel}. ` +
        "Pin the specifier to a 40-hex commit.",
    );
    return;
  }

  const outcome = execute(
    {
      spec: `github:microsoft/agentrc#${fixture.pinnedSha}`,
      args: ["readiness", "--json"],
    },
    fixture,
  );
  assert.equal(outcome.commitLabel, "pinned");
  assert.notEqual(outcome.commitLabel, "head");
  assert.equal(outcome.cwd, fixture.workspace);
  assert.equal(outcome.uid, process.getuid());
  assert.equal(outcome.workspace, "workspace-marker\n");
  assert.equal(outcome.sawSentinel, true);
}

test("acreadiness npx github specifiers stay on a pinned commit", { timeout: 180_000 }, () => {
  const commands = productCommands();
  for (const required of requiredCommands) {
    const matches = commands.filter((command) => command.file === required.file);
    assert.ok(
      matches.length >= required.minimum,
      `${required.file} should instruct npx to run github:microsoft/agentrc ` +
        `(found ${matches.length}, need ${required.minimum})`,
    );
  }
  assert.ok(commands.length >= 4);
  const fixture = buildFixture();
  const failures = [];
  for (const command of commands) {
    try {
      assertExecutesPinnedCommit(command, fixture);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.deepEqual(failures, [], failures.join("\n\n"));
});

test("a branch committish still executes the moved default branch", { timeout: 60_000 }, () => {
  const fixture = buildFixture();
  const outcome = execute(
    {
      spec: "github:microsoft/agentrc#main",
      args: ["readiness", "--json"],
    },
    fixture,
  );
  assert.equal(outcome.commitLabel, "head");
  assert.notEqual(outcome.commitLabel, "pinned");
  assert.equal(outcome.cwd, fixture.workspace);
  assert.equal(outcome.workspace, "workspace-marker\n");
  assert.equal(outcome.sawSentinel, true);
  assert.equal(outcome.uid, process.getuid());
});
