import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./notebook-canvas.mjs", import.meta.url), "utf8");
const runner = source.slice(source.indexOf("const pythonRunner = String.raw`") + "const pythonRunner = String.raw`".length);
const windowsLock = runner.slice(runner.indexOf("def lock_windows_process_creation"), runner.indexOf("def lock_macos_process_creation"));

test("the Windows job handle is closed before any cell runs", () => {
    assert.match(windowsLock, /kernel32\.CloseHandle\(job\)/);
    assert.doesNotMatch(windowsLock, /return job/);
    assert.doesNotMatch(runner, /PROCESS_LOCK\s*=/);
});
