import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "webmcpify"
);

const PACKAGE_RUNNER =
  /\b(?:npx|bunx|pnpx|uvx|pnpm\s+dlx|yarn\s+dlx|npm\s+(?:exec|x)|pipx\s+run)\b/;
const UNATTENDED_OR_FLOATING =
  /(?:\s-y\b|--yes\b|@latest\b|@next\b|modern-web-guidance)/;

function skillTextFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skillTextFiles(full);
    return /\.(?:md|ts|js|json)$/.test(entry.name) ? [full] : [];
  });
}

test("webmcpify never has the agent fetch and run an unpinned package unattended", () => {
  const hits = [];
  for (const file of skillTextFiles(skillDir)) {
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (PACKAGE_RUNNER.test(line) && UNATTENDED_OR_FLOATING.test(line)) {
          hits.push(`${path.relative(skillDir, file)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(hits, []);
});

test("webmcpify treats its bundled references as authoritative", () => {
  for (const file of skillTextFiles(skillDir)) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /prefer (?:the )?live (?:official )?guides/i,
      `${path.relative(skillDir, file)} ranks downloaded guidance above the bundled references`
    );
  }
});
