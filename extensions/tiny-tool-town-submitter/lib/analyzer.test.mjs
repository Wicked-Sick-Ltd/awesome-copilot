import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { inspectRepository, resolveRepoRoot } from "./analyzer.mjs";
import { resolveTrustedExecutable } from "./trusted-exec.mjs";

const isWindows = process.platform === "win32";
const realGit = execFileSync(isWindows ? "where" : "which", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();

function writeScript(directory, name, body) {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
}

function setupFixture(t) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "tiny-tool-town-")));
    const repo = join(base, "repo");
    const trustedBin = join(base, "trusted-bin");
    const markers = join(base, "markers");
    mkdirSync(repo);
    mkdirSync(trustedBin);
    mkdirSync(markers);

    execFileSync(realGit, ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync(realGit, ["remote", "add", "origin", "https://github.com/example-owner/example-tool.git"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# Example tool\n\nA tiny example tool used to exercise the analyzer in tests.\n", "utf8");

    // Executables a malicious repository would ship at its root.
    writeScript(repo, "git", `echo planted >> "${join(markers, "planted-git")}"\nexec "${realGit}" "$@"`);
    writeScript(repo, "gh", `echo planted >> "${join(markers, "planted-gh")}"\necho '{}'`);

    // A stand-in for the user's real GitHub CLI, installed outside the repository.
    writeScript(trustedBin, "gh", `echo "$@" >> "${join(markers, "trusted-gh")}"\necho '{"name":"example-tool"}'`);

    const originalPath = process.env.PATH;
    t.after(() => {
        process.env.PATH = originalPath;
        rmSync(base, { recursive: true, force: true });
    });
    return { repo, trustedBin, markers, originalPath };
}

test("analysis never runs git or gh found through a relative PATH entry", { skip: isWindows }, async (t) => {
    const { repo, trustedBin, markers, originalPath } = setupFixture(t);
    // A relative entry resolves against the child's working directory, which reproduces
    // the Windows behaviour of searching the current directory before PATH.
    process.env.PATH = [".", trustedBin, originalPath].join(delimiter);

    const result = await inspectRepository(repo);

    assert.equal(existsSync(join(markers, "planted-git")), false, "planted git was executed");
    assert.equal(existsSync(join(markers, "planted-gh")), false, "planted gh was executed");
    assert.equal(result.repoPath, repo);
    assert.equal(result.facts.repoSlug, "example-owner/example-tool");
    assert.match(readFileSync(join(markers, "trusted-gh"), "utf8"), /repo view example-owner\/example-tool/);
});

test("analysis refuses git or gh resolved inside the inspected repository", { skip: isWindows }, async (t) => {
    const { repo, trustedBin, markers, originalPath } = setupFixture(t);
    process.env.PATH = [repo, trustedBin, originalPath].join(delimiter);

    await resolveRepoRoot(repo);
    await inspectRepository(repo);

    assert.equal(existsSync(join(markers, "planted-git")), false, "planted git was executed");
    assert.equal(existsSync(join(markers, "planted-gh")), false, "planted gh was executed");
    assert.ok(existsSync(join(markers, "trusted-gh")), "trusted gh was not used");
});

test("a subdirectory scan does not trust binaries planted in a parent directory", { skip: isWindows }, async (t) => {
    const { repo, trustedBin, markers, originalPath } = setupFixture(t);
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    process.env.PATH = [repo, trustedBin, originalPath].join(delimiter);

    const result = await inspectRepository(sub);

    assert.equal(existsSync(join(markers, "planted-git")), false, "planted git was executed");
    assert.equal(existsSync(join(markers, "planted-gh")), false, "planted gh was executed");
    assert.equal(result.repoPath, repo);
    assert.ok(existsSync(join(markers, "trusted-gh")), "trusted gh was not used");
});

test("resolveTrustedExecutable returns an absolute path outside untrusted roots", { skip: isWindows }, async (t) => {
    const { repo, trustedBin, originalPath } = setupFixture(t);
    process.env.PATH = [".", repo, trustedBin, originalPath].join(delimiter);

    assert.equal(await resolveTrustedExecutable("gh", [repo]), join(trustedBin, "gh"));

    process.env.PATH = [".", repo].join(delimiter);
    await assert.rejects(resolveTrustedExecutable("gh", [repo]), /not found/i);
});

test("resolveTrustedExecutable refuses a link that points into an untrusted root", { skip: isWindows }, async (t) => {
    const { repo, trustedBin, originalPath } = setupFixture(t);
    const linkBin = join(trustedBin, "..", "link-bin");
    mkdirSync(linkBin);
    symlinkSync(join(repo, "gh"), join(linkBin, "gh"));
    process.env.PATH = [linkBin, trustedBin, originalPath].join(delimiter);

    assert.equal(await resolveTrustedExecutable("gh", [repo]), join(trustedBin, "gh"));
});
