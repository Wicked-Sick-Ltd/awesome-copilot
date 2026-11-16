import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import test from "node:test";

import { sessionCapture } from "./sdk-stub.mjs";
import { commandExecutable, resolveWindowsApplication, shellCommandLine } from "./win32-spawn-search.mjs";

// Node 22.23.4 ChildProcess.spawn reaches uv_spawn with the file name and cwd
// unchanged (lib/child_process.js normalizeSpawnArguments; src/process_wrap.cc
// copies options.file and options.cwd into uv_process_options_t). On Windows,
// libuv then searches that cwd for gh.com and gh.exe before PATH. This host is
// Linux, so the wrapper below applies that search to the arguments runGh
// actually passes and executes the image it selects.

const harness = {
    resolutions: [],
    trustedResponder: "",
    sessionDir: "",
};

const originalSpawn = ChildProcess.prototype.spawn;

function isInside(file, directory) {
    if (!file || !directory) {
        return false;
    }
    const from = resolve(directory);
    const to = resolve(file);
    const rel = relative(from, to);
    return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith("..") && !rel.includes(`..${sep}`));
}

function spawnMissing(child, options, cwd) {
    const missing = join(cwd, "gh-was-not-resolved");
    options.file = missing;
    options.args = [missing, ...options.args.slice(1)];
    options.cwd = cwd;
    return originalSpawn.call(child, options);
}

ChildProcess.prototype.spawn = function spawnWithWindowsSearch(options) {
    const cwd = typeof options.cwd === "string" && options.cwd.length > 0 ? options.cwd : process.cwd();
    const command = shellCommandLine(options);
    const requested = command === null ? options.file : commandExecutable(command);
    const ghRequest = /^(?:.*[\\/])?gh(?:\.(?:exe|com))?$/i.test(requested);
    if (!ghRequest) {
        return originalSpawn.call(this, options);
    }

    const image = resolveWindowsApplication(requested, cwd, options.envPairs);
    harness.resolutions.push({
        requested,
        cwd,
        image,
        shell: Boolean(options.shell),
    });

    if (!image) {
        return spawnMissing(this, options, cwd);
    }

    const execute = isInside(image, harness.sessionDir) || image === harness.trustedResponder || isInside(image, harness.trustedResponder) ? image : harness.trustedResponder;
    options.file = execute;
    options.args = [execute, ...options.args.slice(1)];
    options.cwd = cwd;
    return originalSpawn.call(this, options);
};

await import("../extension.mjs");

const canvas = sessionCapture.canvas;
const hooks = sessionCapture.hooks;

function writeResponder(file, recordDir) {
    const responder = join(file, "..", "..", "responder.mjs");
    const source = `#!/bin/sh
export GH_RESOLUTION_IMAGE="$0"
export GH_RESOLUTION_RECORD_DIR=${JSON.stringify(recordDir)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(responder)} "$@"
`;
    writeFileSync(file, source, { mode: 0o755 });
}

function writeResponderProgram(file) {
    const source = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const recordDir = process.env.GH_RESOLUTION_RECORD_DIR;
mkdirSync(recordDir, { recursive: true });
writeFileSync(join(recordDir, randomBytes(8).toString("hex") + ".json"), JSON.stringify({
  image: process.env.GH_RESOLUTION_IMAGE,
  command: process.argv.slice(2, 4).join(" "),
  args: process.argv.slice(2),
  pager: Object.hasOwn(process.env, "GH_PAGER") ? process.env.GH_PAGER : null,
}));

const [group, action] = process.argv.slice(2);
const workflow = {
  id: 42,
  name: "CI",
  path: ".github/workflows/ci.yml",
  state: "active",
};
const run = {
  attempt: 1,
  conclusion: "success",
  createdAt: "2026-01-01T00:00:00Z",
  databaseId: 7,
  displayTitle: "CI",
  event: "workflow_dispatch",
  headBranch: "main",
  headSha: "abc",
  jobs: [],
  name: "CI",
  number: 1,
  startedAt: "2026-01-01T00:00:00Z",
  status: "completed",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "https://github.com/octo/demo/actions/runs/7",
  workflowDatabaseId: 42,
  workflowName: "CI",
};
if (group === "repo" && action === "view") {
  process.stdout.write(JSON.stringify({
    nameWithOwner: "octo/demo",
    defaultBranchRef: { name: "main" },
    url: "https://github.com/octo/demo",
  }));
} else if (group === "workflow" && action === "list") {
  process.stdout.write(JSON.stringify([workflow]));
} else if (group === "run" && action === "list") {
  process.stdout.write(JSON.stringify([run]));
} else if (group === "workflow" && action === "view") {
  process.stdout.write(\`name: CI
on:
  workflow_dispatch:
    inputs:
      target:
        description: Target environment
        required: false
        default: prod
        type: string
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
\`);
} else if (group === "run" && action === "view") {
  process.stdout.write(JSON.stringify(run));
} else if (group === "workflow" && action === "run") {
  process.stdout.write("Triggered\\n");
} else {
  process.stderr.write("unexpected gh arguments\\n");
  process.exit(1);
}
`;
    writeFileSync(file, source, { mode: 0o755 });
}

function readRecords(directory) {
    return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

async function exercise(instanceId) {
    await hooks.onSessionStart({ workingDirectory: harness.sessionDir });
    const opened = await canvas.open({ instanceId, input: {} });
    const details = await canvas.actions.find((action) => action.name === "get_workflow_details").handler({
        instanceId,
        input: { workflowId: 42 },
    });
    assert.equal(details.dispatch.supported, true);
    const runResponse = await fetch(new URL("api/run-details?id=7", opened.url));
    assert.equal(runResponse.status, 200);
    const triggered = await canvas.actions.find((action) => action.name === "run_workflow").handler({
        instanceId,
        input: { workflowId: 42, ref: "main", inputs: { target: "prod" } },
    });
    assert.match(triggered.message, /Triggered/);
    await canvas.onClose({ instanceId });
}

function installLayout(root, plantedName) {
    const sessionDir = join(root, "session");
    const trustedDir = join(root, "trusted");
    const plantedRecords = join(root, "planted-records");
    const trustedRecords = join(root, "trusted-records");
    mkdirSync(sessionDir);
    mkdirSync(trustedDir);
    mkdirSync(plantedRecords);
    mkdirSync(trustedRecords);
    writeResponderProgram(join(root, "responder.mjs"));
    writeResponder(join(sessionDir, plantedName), plantedRecords);
    const trustedResponder = join(trustedDir, "gh.exe");
    writeResponder(trustedResponder, trustedRecords);
    writeResponder(join(trustedDir, "gh"), trustedRecords);
    return { sessionDir, trustedDir, plantedRecords, trustedRecords, trustedResponder };
}

async function runCase(t, plantedName) {
    const root = mkdtempSync(join(tmpdir(), "repo-actions-hub-"));
    const layout = installLayout(root, plantedName);
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousNoDefault = Object.keys(process.env).find((key) => key.toLowerCase() === "nodefaultcurrentdirectoryinexepath");
    process.chdir(layout.sessionDir);
    process.env.PATH = `${layout.trustedDir}${delimiter}${previousPath ?? ""}`;
    if (previousNoDefault) {
        delete process.env[previousNoDefault];
    }
    harness.resolutions = [];
    harness.sessionDir = layout.sessionDir;
    harness.trustedResponder = layout.trustedResponder;
    const instanceId = `instance-${plantedName}`;
    let thrown = null;
    try {
        await exercise(instanceId);
    } catch (error) {
        thrown = error;
        await canvas.onClose({ instanceId }).catch(() => {});
    } finally {
        process.chdir(previousCwd);
        process.env.PATH = previousPath;
        if (previousNoDefault) {
            process.env[previousNoDefault] = "1";
        }
        t.after(() => rmSync(root, { recursive: true, force: true }));
    }

    const planted = readRecords(layout.plantedRecords);
    const trusted = readRecords(layout.trustedRecords);
    const sessionImages = harness.resolutions.filter((entry) => isInside(entry.image, layout.sessionDir));
    assert.deepEqual(
        sessionImages.map((entry) => ({ requested: entry.requested, image: entry.image, shell: entry.shell })),
        [],
        `Windows search executed ${plantedName} from the session directory: ${JSON.stringify(planted.map((record) => record.command))}`,
    );
    assert.equal(thrown, null, thrown ? thrown.stack : "");
    for (const command of ["repo view", "workflow list", "run list", "workflow view", "run view", "workflow run"]) {
        assert.ok(
            trusted.some((record) => record.command === command && record.pager === "cat"),
            `trusted gh did not perform ${command} with GH_PAGER=cat`,
        );
    }
    assert.equal(planted.length, 0);
}

test("session gh.exe is not the image for repo view, workflow list, run list, workflow view, run view, or workflow run", async (t) => {
    await runCase(t, "gh.exe");
});

test("session gh.com is not chosen ahead of PATH gh.exe for those same gh operations", async (t) => {
    await runCase(t, "gh.com");
});

test("session GH.EXE is not chosen by the case-insensitive cwd search", async (t) => {
    await runCase(t, "GH.EXE");
});
