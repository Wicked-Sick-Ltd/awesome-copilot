import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(repoRoot, "skills", "sandbox-npm-install", "scripts", "install.sh");
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Each stub appends "<name> as=<root|user> <args>" to $STUB_LOG. The sudo stub
// marks everything it runs with STUB_AS_ROOT=1, so the log shows which code ran
// with elevated privileges. apt-get and sudo are always stubbed so the test
// never touches the real system.
const stubs = {
  npm: `#!/usr/bin/env bash
as=user; [[ "\${STUB_AS_ROOT:-0}" == 1 ]] && as=root
echo "npm as=$as $*" >> "$STUB_LOG"
case "$1" in
  ci|install)
    mkdir -p node_modules/.bin
    if [[ "\${STUB_LOCAL_PLAYWRIGHT:-0}" == 1 ]]; then
      cp "$STUB_DIR/local-playwright" node_modules/.bin/playwright
      chmod +x node_modules/.bin/playwright
    fi
    ;;
esac
`,
  npx: `#!/usr/bin/env bash
as=user; [[ "\${STUB_AS_ROOT:-0}" == 1 ]] && as=root
echo "npx as=$as $*" >> "$STUB_LOG"
if [[ -x "node_modules/.bin/$1" ]]; then
  exec "node_modules/.bin/$@"
fi
echo "registry-fetch as=$as $1" >> "$STUB_LOG"
`,
  sudo: `#!/usr/bin/env bash
if [[ "$1" == "-n" && "$2" == "true" && $# -eq 2 ]]; then
  [[ "\${STUB_SUDO:-none}" == passwordless ]]
  exit $?
fi
while [[ "$1" == -* ]]; do
  if [[ "$1" == "--" ]]; then shift; break; fi
  shift
done
echo "sudo $*" >> "$STUB_LOG"
STUB_AS_ROOT=1 exec "$@"
`,
  "apt-get": `#!/usr/bin/env bash
as=user; [[ "\${STUB_AS_ROOT:-0}" == 1 ]] && as=root
echo "apt-get as=$as $*" >> "$STUB_LOG"
`,
  "local-playwright": `#!/usr/bin/env bash
as=user; [[ "\${STUB_AS_ROOT:-0}" == 1 ]] && as=root
echo "local-playwright as=$as $*" >> "$STUB_LOG"
if [[ "$1" == "install-deps" && " $* " == *" --dry-run "* ]]; then
  cat "$STUB_DRYRUN_FILE"
  exit "\${STUB_DRYRUN_EXIT:-0}"
fi
`,
};

const NEW_DRYRUN = "Missing system dependencies (2):\n  libgbm1\n  libnss3\n";
const LEGACY_DRYRUN =
  'sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends libnss3 libgbm1"\n';

function runInstall(
  t,
  { playwrightDep = false, lockfile = true, sudo = "passwordless", dryRun = NEW_DRYRUN, dryRunExit = 1 } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-npm-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fakeRepo = path.join(root, "repo");
  const scriptDir = path.join(fakeRepo, "skills", "sandbox-npm-install", "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  const depsBase = path.join(root, "deps");
  const original = fs.readFileSync(installScript, "utf8");
  const depsLine = 'readonly DEPS_BASE="/home/agent/project-deps"';
  assert.equal(original.split(depsLine).length, 2, "install.sh DEPS_BASE line changed; update the test fixture");
  fs.writeFileSync(
    path.join(scriptDir, "install.sh"),
    original.replace(depsLine, `readonly DEPS_BASE=${JSON.stringify(depsBase)}`)
  );

  const workspace = path.join(fakeRepo, "app");
  fs.mkdirSync(workspace);
  const pkg = { name: "app", version: "1.0.0", devDependencies: {} };
  if (playwrightDep) pkg.devDependencies["@playwright/test"] = "1.65.1";
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify(pkg));
  if (lockfile) fs.writeFileSync(path.join(workspace, "package-lock.json"), "{}");

  const stubDir = path.join(root, "bin");
  fs.mkdirSync(stubDir);
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(stubDir, name), body, { mode: 0o755 });
  }
  const dryRunFile = path.join(root, "dry-run.txt");
  fs.writeFileSync(dryRunFile, dryRun);
  const logFile = path.join(root, "log.txt");
  fs.writeFileSync(logFile, "");

  const result = spawnSync("bash", [path.join(scriptDir, "install.sh"), "--workspace", workspace, "--playwright"], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      STUB_DIR: stubDir,
      STUB_LOG: logFile,
      STUB_SUDO: sudo,
      STUB_LOCAL_PLAYWRIGHT: playwrightDep ? "1" : "0",
      STUB_DRYRUN_FILE: dryRunFile,
      STUB_DRYRUN_EXIT: String(dryRunExit),
    },
  });
  const log = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  return { ...result, output: result.stdout + result.stderr, log };
}

function assertNoNpmCodeAsRoot(log) {
  const elevated = log.filter((line) => /^(npx|npm|local-playwright|registry-fetch) as=root\b/.test(line));
  assert.deepEqual(elevated, [], `npm package code ran as root:\n${log.join("\n")}`);
  const sudoCalls = log.filter((line) => line.startsWith("sudo "));
  for (const call of sudoCalls) {
    assert.match(call, /^sudo apt-get /, `sudo ran something other than apt-get:\n${log.join("\n")}`);
  }
}

test("never fetches playwright from the registry, as root or otherwise", { skip: runningAsRoot }, (t) => {
  const run = runInstall(t, { playwrightDep: false });
  assertNoNpmCodeAsRoot(run.log);
  assert.deepEqual(
    run.log.filter((line) => line.startsWith("registry-fetch") || line.startsWith("npx ")),
    [],
    `unpinned playwright was resolved through npx:\n${run.log.join("\n")}`
  );
  assert.notEqual(run.status, 0, "should refuse when playwright is not installed from the lockfile");
  assert.match(run.output, /playwright/i);
});

test("uses the lockfile-pinned playwright as the user and elevates only apt-get", { skip: runningAsRoot }, (t) => {
  const run = runInstall(t, { playwrightDep: true });
  assert.equal(run.status, 0, run.output);
  assertNoNpmCodeAsRoot(run.log);
  assert.ok(run.log.includes("local-playwright as=user install chromium"), run.log.join("\n"));
  assert.deepEqual(
    run.log.filter((line) => line.startsWith("sudo ")),
    ["sudo apt-get update", "sudo apt-get install -y --no-install-recommends -- libgbm1 libnss3"]
  );
});

test("reads the package list from the pre-1.60 dry-run format", { skip: runningAsRoot }, (t) => {
  const run = runInstall(t, { playwrightDep: true, dryRun: LEGACY_DRYRUN, dryRunExit: 0 });
  assert.equal(run.status, 0, run.output);
  assertNoNpmCodeAsRoot(run.log);
  assert.deepEqual(
    run.log.filter((line) => line.startsWith("sudo ")),
    ["sudo apt-get update", "sudo apt-get install -y --no-install-recommends -- libnss3 libgbm1"]
  );
});

test("skips apt-get install when nothing is missing", { skip: runningAsRoot }, (t) => {
  const run = runInstall(t, {
    playwrightDep: true,
    dryRun: "All system dependencies are installed.\n",
    dryRunExit: 0,
  });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(
    run.log.filter((line) => line.startsWith("sudo ")),
    ["sudo apt-get update"]
  );
});

test("refuses package names that are not plain distro package names", { skip: runningAsRoot }, (t) => {
  for (const bad of ["-oAPT::Update::Pre-Invoke::=touch", "libnss3;id", "$(id)", "../x"]) {
    const run = runInstall(t, {
      playwrightDep: true,
      dryRun: `Missing system dependencies (2):\n  libnss3\n  ${bad}\n`,
    });
    assert.notEqual(run.status, 0, `accepted ${bad}`);
    assertNoNpmCodeAsRoot(run.log);
    assert.deepEqual(
      run.log.filter((line) => line.startsWith("sudo apt-get install")),
      [],
      `installed packages despite ${bad}`
    );
  }
});

test("without passwordless sudo it elevates nothing and never suggests sudo npx", { skip: runningAsRoot }, (t) => {
  const run = runInstall(t, { playwrightDep: true, sudo: "none" });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.log.filter((line) => line.startsWith("sudo ")), []);
  assert.ok(run.log.includes("local-playwright as=user install chromium"), run.log.join("\n"));
  assert.doesNotMatch(run.output, /sudo npx/);
});

test("refuses --playwright without a package-lock.json", { skip: runningAsRoot }, (t) => {
  const run = runInstall(t, { playwrightDep: true, lockfile: false });
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /package-lock\.json/);
  assert.deepEqual(run.log, [], "should refuse before installing anything");
});
