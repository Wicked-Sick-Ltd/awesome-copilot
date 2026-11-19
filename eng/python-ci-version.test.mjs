// Locks the repo CI Python standard: single setup-python pins are 3.13,
// and a test matrix, when one exists, is exactly 3.12 / 3.13 / 3.14.
// Run: node --test eng/python-ci-version.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(root, ".github/workflows");
const MATRIX = ["3.12", "3.13", "3.14"];
const MATRIX_REF = "${{ matrix.python-version }}";

function workflowFiles() {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(workflowsDir, name));
}

function assertQuotedVersion(value, label) {
  assert.equal(typeof value, "string", `${label} version ${JSON.stringify(value)} must be a quoted string`);
  assert.match(value, /^\d+\.\d+$/, `${label} unsupported python matrix entry ${value}`);
}

function assertMatrixAxis(value, label) {
  assert.ok(Array.isArray(value), `${label} matrix must be a list`);
  for (const entry of value) assertQuotedVersion(entry, label);
  assert.deepEqual(value, MATRIX, label);
}

function stepVersions(steps) {
  if (!Array.isArray(steps)) return [];
  const found = [];
  for (const step of steps) {
    const value = step?.with?.["python-version"];
    if (value !== undefined) found.push(value);
  }
  return found;
}

function assertWorkflowDocument(doc, label) {
  const jobs = doc?.jobs;
  assert.ok(jobs && typeof jobs === "object" && !Array.isArray(jobs), `${label} has no jobs`);
  const pins = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    const where = `${label} job ${jobName}`;
    const matrix = job?.strategy?.matrix;
    const axis = matrix?.["python-version"];
    if (axis !== undefined) assertMatrixAxis(axis, where);
    const includes = Array.isArray(matrix?.include) ? matrix.include : [];
    for (const entry of includes) {
      if (!entry || !Object.hasOwn(entry, "python-version")) continue;
      const version = entry["python-version"];
      assertQuotedVersion(version, `${where} include`);
      assert.ok(MATRIX.includes(version), `${where} include adds ${version}`);
    }
    let sawMatrixRef = false;
    for (const value of stepVersions(job?.steps)) {
      if (value === MATRIX_REF) {
        sawMatrixRef = true;
        pins.push(value);
        continue;
      }
      assert.equal(value, "3.13", `${where} pins ${JSON.stringify(value)}`);
      pins.push(value);
    }
    if (sawMatrixRef) {
      assert.notEqual(axis, undefined, `${where} uses a matrix reference without a version list`);
    }
  }
  return pins;
}

function pythonImages(text) {
  const images = [];
  const pattern = /^\s*from(?:\s+--\S+)*\s+python:(\d+)\.(\d+)/gim;
  for (const match of text.matchAll(pattern)) {
    images.push({ major: Number(match[1]), minor: Number(match[2]), raw: match[0].trim() });
  }
  return images;
}

function assertPythonImages(text, label) {
  for (const image of pythonImages(text)) {
    assert.ok(image.major > 3 || image.minor >= 13, `${label} uses ${image.raw}`);
  }
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

function loadWorkflow(text, label) {
  const doc = yaml.load(text);
  assert.equal(typeof doc, "object", `${label} did not parse`);
  return doc;
}

test("every workflow python-version pin is 3.13 or the 3.12/3.13/3.14 matrix", () => {
  const pins = [];
  for (const file of workflowFiles()) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("python-version")) continue;
    const name = path.basename(file);
    pins.push(...assertWorkflowDocument(loadWorkflow(text, name), name));
  }
  assert.ok(pins.includes("3.13"), "expected the contributor-check setup-python pins");
});

test("a patch version in a matrix is rejected instead of dropped", () => {
  const doc = loadWorkflow(
    [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      '        python-version: ["3.12", "3.13", "3.14", "3.11.9"]',
    ].join("\n"),
    "patch",
  );
  assert.throws(() => assertWorkflowDocument(doc, "patch"), /unsupported python matrix entry 3\.11\.9/);
});

test("a block-style matrix and a second job with the same list are accepted", () => {
  const doc = loadWorkflow(
    [
      "jobs:",
      "  one:",
      "    strategy:",
      "      matrix:",
      "        python-version:",
      '          - "3.12"',
      '          - "3.13"',
      '          - "3.14"',
      "    steps:",
      "      - uses: actions/setup-python@v5",
      "        with:",
      '          python-version: "${{ matrix.python-version }}"',
      "  two:",
      "    strategy:",
      "      matrix:",
      '        python-version: ["3.12", "3.13", "3.14"]',
      "        include:",
      '          - python-version: "3.14"',
      "    steps:",
      "      - uses: actions/setup-python@v5",
      "        with:",
      '          python-version: "${{ matrix.python-version }}"',
    ].join("\n"),
    "block",
  );
  assertWorkflowDocument(doc, "block");
});

test("a matrix include cannot add a Python version outside 3.12/3.13/3.14", () => {
  const doc = loadWorkflow(
    [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      '        python-version: ["3.12", "3.13", "3.14"]',
      "        include:",
      '          - python-version: "3.11"',
      "    steps:",
      "      - with:",
      '          python-version: "${{ matrix.python-version }}"',
    ].join("\n"),
    "include",
  );
  assert.throws(() => assertWorkflowDocument(doc, "include"), /include adds 3\.11/);
});

test("contributor-check setup-python steps are a single 3.13 pin", () => {
  const text = readFileSync(path.join(workflowsDir, "contributor-check.yml"), "utf8");
  const doc = loadWorkflow(text, "contributor-check.yml");
  const pins = [];
  for (const job of Object.values(doc.jobs)) pins.push(...stepVersions(job.steps));
  assert.deepEqual(pins, ["3.13", "3.13"]);
  assert.equal(text.includes("continue-on-error"), false);
});

test("the Python version suite is a pull request check", () => {
  const workflow = readFileSync(path.join(workflowsDir, "python-ci-version.yml"), "utf8");
  const gate = readFileSync(path.join(root, ".github/submission-gate.yml"), "utf8");
  for (const text of [workflow, gate]) {
    assert.match(text, /\*\*\/Dockerfile/);
    assert.match(text, /\*\*\/Dockerfile\.\*/);
    assert.match(text, /\*\*\/\*\.Dockerfile/);
  }
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node --test eng\/python-ci-version\.test\.mjs/);
  assert.match(gate, /workflow: python-ci-version\.yml/);
});

test("platform-qualified and lowercase FROM lines below 3.13 are rejected", () => {
  assert.throws(
    () => assertPythonImages("FROM --platform=linux/amd64 python:3.12-slim\n", "platform"),
    /python:3\.12/,
  );
  assert.throws(() => assertPythonImages("from python:3.12\n", "lower"), /python:3\.12/);
  assertPythonImages("FROM --platform=linux/amd64 python:3.13\nfrom python:3.14-alpine\n", "current");
});

test("Dockerfiles are not based on a Python image older than 3.13", () => {
  const dockerfiles = walk(root).filter((file) => {
    const base = path.basename(file);
    return base === "Dockerfile" || base.startsWith("Dockerfile.") || base.endsWith(".Dockerfile");
  });
  for (const file of dockerfiles) {
    assertPythonImages(readFileSync(file, "utf8"), path.relative(root, file));
  }
});
