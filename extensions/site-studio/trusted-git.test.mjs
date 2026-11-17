import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./extension.mjs", import.meta.url), "utf8");

test("git trust uses the opened working directory, not the session-state path", () => {
    assert.doesNotMatch(source, /workspacePath\s*=\s*session\.workspacePath/);
    const capture = source.slice(source.indexOf("function captureWorkingDirectory"), source.indexOf("function cloneJson"));
    assert.match(capture, /ctx\?\.session\?\.workingDirectory/);
    assert.doesNotMatch(capture, /if\s*\(\s*!workspacePath/);
    const open = source.slice(source.indexOf("open: async (ctx)"), source.indexOf("onClose:"));
    const captureAt = open.indexOf("captureWorkingDirectory(ctx)");
    const branchAt = open.indexOf("readBranchFromGit()");
    assert.ok(captureAt >= 0 && branchAt > captureAt, "working directory is captured before git runs");
});
