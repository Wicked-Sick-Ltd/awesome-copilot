// Spec for Validate Submission Gate (.github/workflows/validate-submission-gate.yml).
//
// A pull request against main is materialized as a merge commit. The workflow
// file GitHub runs is the one in that merge commit. These tests change the
// gate test, the gate module, or the installed js-yaml package, and not the
// workflow file. They fail while the job executes those pull-request copies.
//
// Not covered here: a pull request that replaces this workflow file (GitHub
// then runs that replacement), the bootstrap checkout in submission-gate.yml
// when the base branch has no gate, and other pull_request workflows that
// validate the pull request's own content.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { matchesAny } from "./submission-gate.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/validate-submission-gate.yml";
const trustedTestName = "globToRegExp follows GitHub path filter semantics";
const npmCache = path.join(os.tmpdir(), "validate-submission-gate-npm-cache");

function git(cwd, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Submission Gate Test",
      "-c",
      "user.email=submission-gate-test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function expandExpressions(value, expressions) {
  if (typeof value !== "string" || !value.includes("${{")) return value;
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, raw) => {
    const key = raw.trim();
    if (!Object.hasOwn(expressions, key)) {
      throw new Error(`unsupported Actions expression: ${key}`);
    }
    return expressions[key];
  });
}

function triggerOf(workflow) {
  const on = workflow.on ?? workflow[true];
  assert.ok(on && Object.hasOwn(on, "pull_request"), "workflow must trigger on pull_request");
  return on.pull_request;
}

// GitHub runs the workflow when any changed path matches, applying "!" patterns
// in order. matchesAny is the repository's glob implementation.
function changedPathSelected(changedFiles, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return changedFiles.some((file) => {
    let matched = false;
    for (const pattern of patterns) {
      const negated = pattern.startsWith("!");
      const body = negated ? pattern.slice(1) : pattern;
      if (!matchesAny(file, [body])) continue;
      matched = !negated;
    }
    return matched;
  });
}

function permissionsOf(workflow, job) {
  const permissions = job.permissions ?? workflow.permissions;
  assert.equal(typeof permissions, "object", "job must set a permissions map");
  assert.ok(!Array.isArray(permissions), "job must set a permissions map");
  return permissions;
}

function assertReadOnlyToken(workflow, job) {
  const permissions = permissionsOf(workflow, job);
  for (const [scope, level] of Object.entries(permissions)) {
    assert.notEqual(level, "write", `${scope} permission is write`);
  }
  assert.equal(permissions.contents, "read");
  const pullRequests = permissions["pull-requests"];
  assert.ok(
    pullRequests == null || pullRequests === "none" || pullRequests === "read",
    "pull-requests permission must not be write",
  );
}

// actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5:
// empty ref on the workflow repository uses github.ref and github.sha;
// a 40-character ref is the commit; refs/pull/*/merge fetched with that
// commit checks out that commit. pull_request sets those to the merge commit.
function resolveCheckoutSha(refInput, event) {
  let ref = refInput || "";
  let commit = "";
  if (!ref) {
    ref = event.ref;
    commit = event.sha;
  } else if (/^[0-9a-f]{40}$/i.test(ref)) {
    commit = ref.toLowerCase();
    ref = "";
  }
  if (!ref && commit) return commit;
  if (ref.toLowerCase().startsWith("refs/pull/") && commit) return commit.toLowerCase();
  if (ref === event.ref) return event.sha;
  if (ref === "main" || ref === "refs/heads/main") return event.baseSha;
  throw new Error(`unsupported checkout ref: ${refInput || "(default)"}`);
}

function runBash(script, cwd, env) {
  const scriptPath = path.join(os.tmpdir(), `gate-step-${process.pid}-${Math.random().toString(16).slice(2)}.sh`);
  fs.writeFileSync(scriptPath, script);
  try {
    return spawnSync("bash", ["-e", scriptPath], { cwd, env, encoding: "utf8" });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

function stepEnv(workspace, event) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || "C.UTF-8",
    TMPDIR: os.tmpdir(),
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    GITHUB_SHA: event.sha,
    GITHUB_REF: event.ref,
    GITHUB_WORKSPACE: workspace,
    GITHUB_EVENT_NAME: "pull_request",
    // Placeholder only. The workflow's token is the Actions GITHUB_TOKEN.
    GITHUB_TOKEN: "placeholder-token",
  };
}

function checkoutInto(repo, dest, sha) {
  if (!fs.existsSync(path.join(dest, ".git"))) {
    fs.rmSync(dest, { recursive: true, force: true });
    git(repo, ["worktree", "add", "--detach", dest, sha]);
    return;
  }
  git(dest, ["checkout", "--force", sha]);
  git(dest, ["clean", "-ffdx"]);
}

function executeJob(repo, workspace, workflow, event) {
  const job = workflow.jobs?.["validate-submission-gate"];
  assert.ok(job, "validate-submission-gate job is missing");
  assertReadOnlyToken(workflow, job);
  const steps = job.steps ?? [];
  const checkedOut = [];
  let output = "";
  let testStepExit = null;
  const env = stepEnv(workspace, event);

  for (const step of steps) {
    if (step.uses) {
      const uses = String(step.uses);
      if (uses.startsWith("actions/setup-node@")) {
        assert.ok(process.version.startsWith("v22."), `node ${process.version} is not the workflow's Node 22`);
        continue;
      }
      if (!uses.startsWith("actions/checkout@")) {
        throw new Error(`unsupported action ${uses}`);
      }
      const inputs = step.with ?? {};
      assert.equal(
        inputs["persist-credentials"],
        false,
        "checkout must set persist-credentials: false (the action default is true)",
      );
      const refInput = expandExpressions(inputs.ref ?? "", event.expressions);
      const sha = resolveCheckoutSha(refInput, event);
      const relative = expandExpressions(inputs.path ?? ".", event.expressions);
      const dest = path.resolve(workspace, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      checkoutInto(repo, dest, sha);
      checkedOut.push(sha);
      const localConfig = git(dest, ["config", "--local", "--list"]);
      assert.equal(localConfig.includes("extraheader"), false);
      continue;
    }

    if (step.run == null) continue;
    const script = expandExpressions(String(step.run), event.expressions);
    const cwd = step["working-directory"]
      ? path.resolve(workspace, expandExpressions(String(step["working-directory"]), event.expressions))
      : workspace;
    const result = runBash(script, cwd, env);
    output += `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (script.includes("node --test")) testStepExit = result.status;
    if (result.status !== 0) break;
  }

  return { checkedOut, output, testStepExit };
}

function buildPullRequest(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pr-"));
  const repo = path.join(root, "repo");
  const workspace = path.join(root, "workspace");
  const clone = spawnSync("git", ["clone", "--local", sourceRoot, repo], { encoding: "utf8" });
  if (clone.status !== 0) throw new Error(`git clone failed\n${clone.stdout}\n${clone.stderr}`);
  const sourceHead = git(sourceRoot, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "--detach", sourceHead]);
  fs.copyFileSync(path.join(sourceRoot, workflowPath), path.join(repo, workflowPath));
  if (git(repo, ["status", "--porcelain", "--", workflowPath])) {
    git(repo, ["add", "--", workflowPath]);
    git(repo, ["commit", "-m", "maintained submission-gate workflow"]);
  }
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "-f", "main", baseSha]);
  git(repo, ["checkout", "-B", "attacker", baseSha]);
  mutate(repo);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "pull request"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "--no-edit", "attacker"]);
  const mergeSha = git(repo, ["rev-parse", "HEAD"]);
  return { root, repo, workspace, baseSha, headSha, mergeSha };
}

function runMaintainedWorkflow(mutate) {
  const pull = buildPullRequest(mutate);
  try {
    const changed = git(pull.repo, ["diff", "--name-only", `${pull.baseSha}...${pull.headSha}`])
      .split("\n")
      .filter(Boolean);
    assert.equal(
      changed.includes(workflowPath),
      false,
      "this spec changes files the maintained workflow checks out, not the workflow file",
    );
    const workflow = yaml.load(git(pull.repo, ["show", `${pull.mergeSha}:${workflowPath}`]));
    const trigger = triggerOf(workflow);
    assert.ok(
      !trigger.branches || trigger.branches.includes("main"),
      "pull request targets main",
    );
    assert.ok(
      changedPathSelected(changed, trigger.paths),
      `workflow did not run for ${changed.join(", ")}`,
    );
    const event = {
      sha: pull.mergeSha,
      ref: "refs/pull/1/merge",
      baseSha: pull.baseSha,
      expressions: {
        "github.sha": pull.mergeSha,
        "github.ref": "refs/pull/1/merge",
        "github.event.pull_request.base.sha": pull.baseSha,
        "github.event.pull_request.head.sha": pull.headSha,
        "github.event.pull_request.base.ref": "main",
        "github.event.pull_request.number": "1",
        "github.token": "placeholder-token",
      },
    };
    const executed = executeJob(pull.repo, pull.workspace, workflow, event);
    return { changed, ...executed };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", pull.workspace], { cwd: pull.repo });
    fs.rmSync(pull.root, { recursive: true, force: true });
  }
}

function assertTrustedExecution(result, sentinels) {
  for (const [label, file] of Object.entries(sentinels)) {
    const wrote = fs.existsSync(file);
    assert.equal(
      wrote,
      false,
      `${label} from the pull request ran (wrote ${file}). ` +
        `node --test step exit ${result.testStepExit}. ` +
        `checkout ${result.checkedOut.join(", ") || "(none)"}. ` +
        `changed ${result.changed.join(", ")}`,
    );
  }
  assert.equal(result.testStepExit, 0, "the trusted submission-gate tests did not succeed");
  assert.match(result.output, new RegExp(trustedTestName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function markConfigUnderReview(repo) {
  fs.appendFileSync(path.join(repo, ".github/submission-gate.yml"), "\n# reviewed-config\n");
}

describe("validate-submission-gate pull_request runner", { concurrency: false }, () => {
  test("a replaced gate test file runs after npm ci --ignore-scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sentinel-"));
    const testSentinel = path.join(root, "test-file");
    const installSentinel = path.join(root, "preinstall");
    try {
      const result = runMaintainedWorkflow((repo) => {
        markConfigUnderReview(repo);
        const packageJson = path.join(repo, "package.json");
        const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        manifest.scripts.preinstall =
          `node -e "require('fs').writeFileSync(${JSON.stringify(installSentinel)}, 'preinstall')"`;
        fs.writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`);
        fs.writeFileSync(
          path.join(repo, "eng/submission-gate.test.mjs"),
          `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(testSentinel)}, "submission-gate.test.mjs");\n`,
        );
      });
      assertTrustedExecution(result, {
        "package.json preinstall": installSentinel,
        "eng/submission-gate.test.mjs": testSentinel,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replaced gate module runs when the trusted test imports it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sentinel-"));
    const moduleSentinel = path.join(root, "module");
    try {
      const result = runMaintainedWorkflow((repo) => {
        markConfigUnderReview(repo);
        fs.writeFileSync(
          path.join(repo, "eng/pwn.mjs"),
          `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(moduleSentinel)}, "submission-gate.mjs");\n`,
        );
        const modulePath = path.join(repo, "eng/submission-gate.mjs");
        const source = fs.readFileSync(modulePath, "utf8");
        const shebang = source.startsWith("#!") ? source.slice(0, source.indexOf("\n") + 1) : "";
        const body = shebang ? source.slice(shebang.length) : source;
        fs.writeFileSync(modulePath, `${shebang}import "./pwn.mjs";\n${body}`);
      });
      assertTrustedExecution(result, { "eng/submission-gate.mjs": moduleSentinel });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replaced js-yaml dependency runs when the trusted test imports it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sentinel-"));
    const dependencySentinel = path.join(root, "dependency");
    const installSentinel = path.join(root, "dependency-preinstall");
    try {
      const result = runMaintainedWorkflow((repo) => {
        markConfigUnderReview(repo);
        const packageDir = path.join(repo, "attacker-js-yaml");
        fs.mkdirSync(packageDir);
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          `${JSON.stringify({
            name: "js-yaml",
            version: "5.4.1",
            main: "index.js",
            scripts: {
              preinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(installSentinel)}, 'preinstall')"`,
            },
          }, null, 2)}\n`,
        );
        fs.writeFileSync(
          path.join(packageDir, "index.js"),
          `const fs = require("fs");\nfs.writeFileSync(${JSON.stringify(dependencySentinel)}, "js-yaml");\nmodule.exports = { load() { return null; }, dump() { return ""; } };\n`,
        );
        const manifestPath = path.join(repo, "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.dependencies["js-yaml"] = "file:./attacker-js-yaml";
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const install = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: npmCache,
            npm_config_fund: "false",
            npm_config_audit: "false",
          },
        });
        if (install.status !== 0) {
          throw new Error(`npm install --package-lock-only failed\n${install.stdout}\n${install.stderr}`);
        }
      });
      assertTrustedExecution(result, {
        "js-yaml preinstall": installSentinel,
        "js-yaml": dependencySentinel,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
