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

// Every comma-separated token is kept. A patch version, an unquoted
// version, or any other non `major.minor` token is rejected here instead
// of being dropped before the comparison with MATRIX.
function matrixEntries(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`python matrix must be an inline list, got ${value}`);
  }
  const body = trimmed.slice(1, -1).trim();
  if (body === "") return [];
  return body.split(",").map((part) => {
    const token = part.trim();
    const quoted = token.match(/^(['"])(.*)\1$/);
    if (!quoted || !/^\d+\.\d+$/.test(quoted[2])) {
      throw new Error(`unsupported python matrix entry ${token}`);
    }
    return quoted[2];
  });
}

function assertWorkflowVersions(text, label) {
  const values = pythonVersionLines(text).map(({ line }) => unquote(line.slice(line.indexOf(":") + 1)));
  const lists = values.filter((entry) => entry.startsWith("["));
  let sawMatrixRef = false;
  for (const value of values) {
    if (value.includes("${{")) {
      assert.equal(value, "${{ matrix.python-version }}", `${label} must pass the matrix through unchanged`);
      sawMatrixRef = true;
      continue;
    }
    if (value.startsWith("[")) {
      assert.deepEqual(matrixEntries(value), MATRIX, label);
      continue;
    }
    assert.equal(value, "3.13", `${label} pins ${value}`);
    assert.equal(value.includes(".x"), false);
  }
  if (sawMatrixRef) {
    assert.ok(lists.length >= 1, `${label} uses a matrix reference without a version list`);
    for (const list of lists) {
      assert.deepEqual(matrixEntries(list), MATRIX, label);
    }
  }
  return values;
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
    if (!pythonVersionLines(text).length) continue;
    pins.push(...assertWorkflowVersions(text, path.basename(file)));
  }
  assert.ok(pins.length >= 2, "expected the contributor-check setup-python pins");
});

test("a patch version in a matrix is rejected instead of dropped", () => {
  assert.throws(
    () => matrixEntries('["3.12", "3.13", "3.14", "3.11.9"]'),
    /unsupported python matrix entry "3\.11\.9"/,
  );
});

test("two jobs may each declare the 3.12/3.13/3.14 matrix", () => {
  const text = [
    'python-version: ["3.12", "3.13", "3.14"]',
    "python-version: ${{ matrix.python-version }}",
    "python-version: ['3.12', '3.13', '3.14']",
    "python-version: ${{ matrix.python-version }}",
  ].join("\n");
  assertWorkflowVersions(text, "two jobs");
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

test("the Python version suite is a pull request check", () => {
  const workflow = readFileSync(path.join(workflowsDir, "python-ci-version.yml"), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /eng\/python-ci-version\.test\.mjs/);
  assert.match(workflow, /\.github\/workflows\/\*\*/);
  assert.match(workflow, /node --test eng\/python-ci-version\.test\.mjs/);

  const gate = readFileSync(path.join(root, ".github/submission-gate.yml"), "utf8");
  assert.match(gate, /workflow: python-ci-version\.yml/);
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
