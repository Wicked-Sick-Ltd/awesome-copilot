import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getGitFileDate, getGitFileDates } from "./git-dates.mjs";

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-dates-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

test("directory names are passed to git without shell interpretation", () => {
  const root = createRepository();
  const marker = path.join(root, "directory-injection");

  getGitFileDates([`tracked.txt;touch ${marker}`], root);

  assert.equal(fs.existsSync(marker), false);
});

test("file names are passed to git without command substitution", () => {
  const root = createRepository();
  const marker = path.join(root, "file-injection");

  getGitFileDate(`$(touch ${marker})`, root);

  assert.equal(fs.existsSync(marker), false);
});
