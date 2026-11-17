import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cloud agent environment.json matches the install and port schema", async () => {
  const raw = await readFile(path.join(root, ".cursor/environment.json"), "utf8");
  const config = JSON.parse(raw);

  assert.equal(config.install, "bash .cursor/install.sh");
  assert.equal(config.start, "true");
  assert.ok(Array.isArray(config.terminals));
  assert.equal(config.terminals.length, 1);
  assert.equal(config.terminals[0].command, "bash .cursor/start.sh");
  assert.equal(config.terminals[0].command.includes('"'), false);
  assert.equal(config.terminals[0].command.includes("$"), false);
  assert.equal(config.terminals[0].command.includes("`"), false);
  assert.ok(Array.isArray(config.ports));
  assert.deepEqual(config.ports, [{ name: "website", port: 4321 }]);
  assert.equal(Object.hasOwn(config, "$schema"), false);
});

test("install and start scripts are executable and non-interactive", async () => {
  for (const script of [".cursor/install.sh", ".cursor/start.sh"]) {
    const file = path.join(root, script);
    await access(file, constants.X_OK);
    const body = await readFile(file, "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash\n/u);
    assert.match(body, /set -euo pipefail/u);
    assert.equal(body.includes("\r"), false);
  }

  const install = await readFile(path.join(root, ".cursor/install.sh"), "utf8");
  assert.match(install, /npm ci\b/u);
  assert.match(install, /npm ci --prefix website/u);
  assert.match(install, /GITHUB_TOKEN/u);
  assert.match(install, /NODE_MINIMUM="22\.12\.0"/u);
  assert.match(
    install,
    /if ! python -m pip install --disable-pip-version-check --upgrade pip; then/u,
  );

  const start = await readFile(path.join(root, ".cursor/start.sh"), "utf8");
  const dataAt = start.indexOf("npm run website:data");
  const devAt = start.indexOf("npm run --prefix website dev");
  assert.ok(dataAt > -1 && devAt > dataAt);
  assert.equal(start.includes("agents.json"), false);
});

test("node_meets_minimum enforces Astro's Node 22.12.0 floor", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "source .cursor/install.sh",
        "node_meets_minimum 22.12.0 22.12.0",
        "node_meets_minimum v22.23.4 22.12.0",
        "if node_meets_minimum 22.11.9 22.12.0; then exit 11; fi",
        "if node_meets_minimum 21.9.0 22.12.0; then exit 12; fi",
      ].join("\n"),
    ],
    { cwd: root },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
});
