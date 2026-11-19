// Locks the repo CI Python standard: single setup-python pins are 3.13,
// and a test matrix, when one exists, is exactly 3.12 / 3.13 / 3.14.
// Run: node --test eng/python-ci-version.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(root, ".github/workflows");
const MATRIX = ["3.12", "3.13", "3.14"];

function workflowFiles() {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(workflowsDir, name));
}

function pythonVersionLines(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*python-version\s*:/.test(line));
}

function unquote(value) {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function listVersions(value) {
  return [...value.matchAll(/['"](\d+\.\d+)['"]/g)].map((match) => match[1]);
}

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".venv") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

test("every workflow python-version pin is 3.13 or the 3.12/3.13/3.14 matrix", () => {
  const pins = [];
  for (const file of workflowFiles()) {
    const text = readFileSync(file, "utf8");
    for (const { line } of pythonVersionLines(text)) {
      const raw = line.slice(line.indexOf(":") + 1);
      const value = unquote(raw);
      pins.push({ file: path.basename(file), value });
      if (value.includes("${{")) {
        assert.equal(
          value,
          "${{ matrix.python-version }}",
          `${path.basename(file)} must pass the matrix through unchanged`,
        );
        const lists = pythonVersionLines(text)
          .map(({ line }) => unquote(line.slice(line.indexOf(":") + 1)))
          .filter((entry) => entry.startsWith("["));
        assert.deepEqual(lists.map(listVersions), [MATRIX], `${path.basename(file)} matrix`);
        continue;
      }
      if (value.startsWith("[")) {
        assert.deepEqual(listVersions(value), MATRIX, `${path.basename(file)} matrix`);
        continue;
      }
      assert.equal(value, "3.13", `${path.basename(file)} pins ${raw.trim()}`);
      assert.equal(value.includes(".x"), false);
    }
  }
  assert.ok(pins.length >= 2, "expected the contributor-check setup-python pins");
});

test("contributor-check setup-python steps are a single 3.13 pin", () => {
  const text = readFileSync(path.join(workflowsDir, "contributor-check.yml"), "utf8");
  const pins = pythonVersionLines(text).map(({ line }) => unquote(line.slice(line.indexOf(":") + 1)));
  assert.deepEqual(pins, ["3.13", "3.13"]);

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("actions/setup-python@")) continue;
    const step = lines.slice(index, index + 8).join("\n");
    assert.equal(step.includes("continue-on-error"), false);
    assert.match(step, /python-version:\s*"3\.13"/);
  }
});

test("Dockerfiles are not based on a Python image older than 3.13", () => {
  const dockerfiles = walk(root).filter((file) => {
    const base = path.basename(file);
    return base === "Dockerfile" || base.startsWith("Dockerfile.") || base.endsWith(".Dockerfile");
  });
  for (const file of dockerfiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^FROM\s+python:(\d+)\.(\d+)/gm)) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      assert.ok(
        major > 3 || minor >= 13,
        `${path.relative(root, file)} uses ${match[0]}`,
      );
    }
  }
});
