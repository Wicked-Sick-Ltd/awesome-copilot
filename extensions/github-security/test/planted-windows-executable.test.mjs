// Security canvas must not run a git.exe or ssh.exe planted in the opened
// repository. These tests fail while execFile is given the bare names "git"
// and "ssh" with that repository as the child working directory.
//
// Run:
//   node --test-concurrency=1 --import ./extensions/github-security/test/register-security-extension.mjs --test ./extensions/github-security/test/planted-windows-executable.test.mjs
//
// The Windows lookup is libuv 1.51.0 search_path, which is what Node.js
// 22.23.4 calls from execFile. It cannot be executed on this host, so each
// product test runs the real canvas function and then applies that lookup to
// the file name and cwd the child actually received.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodeSnippetLoader, SessionInfo, handleCodeSnippetRequest } from "../extension.mjs";
import { windowsSpawnTarget } from "./windows-spawn-path.mjs";

const recorderSource = fileURLToPath(new URL("./invocation-recorder.c", import.meta.url));
const plantedRemote = "git@gitlab.example.com:acme/widgets.git";

test("libuv selects git.exe and ssh.exe from the child cwd", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "security-spawn-"));
	try {
		const cwd = resolve(root, "repo");
		const trusted = resolve(root, "trusted");
		await mkdir(cwd);
		await mkdir(trusted);
		await writeFile(resolve(cwd, "git.exe"), "planted");
		await writeFile(resolve(cwd, "ssh.exe"), "planted");
		await writeFile(resolve(trusted, "git.exe"), "trusted");
		await writeFile(resolve(trusted, "ssh.exe"), "trusted");
		assert.equal(windowsSpawnTarget("git", cwd, trusted), resolve(cwd, "git.exe"));
		assert.equal(windowsSpawnTarget("ssh", cwd, trusted), resolve(cwd, "ssh.exe"));
		assert.equal(windowsSpawnTarget("/usr/bin/git", cwd, trusted), null);
		assert.equal(windowsSpawnTarget("/usr/bin/ssh", cwd, trusted), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("opening the canvas without a repository host does not run a planted git.exe or ssh.exe", async () => {
	const fixture = await createFixture();
	try {
		let failure;
		await withRecorderEnv(fixture, async () => {
			const sessionInfo = new SessionInfo();
			sessionInfo.setWorkingDirectory(fixture.repo);
			try {
				await sessionInfo.getRepositoryInfo();
			} catch (error) {
				failure = error;
			}
		});
		const invocations = await readInvocations(fixture.logPath);
		const git = invocations.find((invocation) => invocation.args.includes("get-url"));
		const ssh = invocations.find((invocation) => invocation.argv0 === "ssh" || invocation.args[0] === "ssh");
		assert.ok(git, `repository discovery did not start git remote get-url${failure ? `: ${failure.message}` : ""}`);
		assert.ok(ssh, `a non-GitHub SSH remote did not start ssh${failure ? `: ${failure.message}` : ""}`);
		const problems = [git, ssh].flatMap((invocation) => spawnProblem(invocation, fixture.repo));
		assert.deepEqual(problems, []);
	} finally {
		await fixture.cleanup();
	}
});

test("loading a commit snippet does not run a planted git.exe", async () => {
	const fixture = await createFixture();
	try {
		const commitSha = "0123456789abcdef";
		let failure;
		await withRecorderEnv(fixture, async () => {
			const loader = new CodeSnippetLoader(fixture.repo);
			const params = new URLSearchParams({
				file: "notes",
				startLine: "1",
				commitSha
			});
			const response = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body ?? ""; } };
			try {
				await handleCodeSnippetRequest({ method: "GET" }, response, loader, params);
			} catch (error) {
				failure = error;
			}
		});
		const invocations = await readInvocations(fixture.logPath);
		const show = invocations.find((invocation) => invocation.args.includes("show") && invocation.args.some((arg) => arg.startsWith(`${commitSha}:`)));
		assert.ok(show, `the snippet request did not start git show for the commit${failure ? `: ${failure.message}` : ""}`);
		assert.deepEqual(spawnProblem(show, fixture.repo), []);
	} finally {
		await fixture.cleanup();
	}
});

function spawnProblem(invocation, repo) {
	const selected = windowsSpawnTarget(invocation.argv0, invocation.cwd, "");
	const commandInsideRepo = isAbsolute(invocation.argv0) && isInside(repo, invocation.argv0);
	const selectedInsideRepo = selected !== null && isInside(repo, selected);
	if (!commandInsideRepo && !selectedInsideRepo) return [];
	return [`execFile ${JSON.stringify(invocation.argv0)} with cwd ${invocation.cwd} resolves to ${selected ?? invocation.argv0}; a repository executable must not be the program that runs`];
}

function isInside(root, candidate) {
	const rootReal = realpathSync(root);
	let candidateReal;
	try {
		candidateReal = realpathSync(candidate);
	} catch {
		return false;
	}
	const fromRoot = relative(rootReal, candidateReal);
	return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function createFixture() {
	const root = await mkdtemp(resolve(tmpdir(), "security-canvas-exec-"));
	const repo = resolve(root, "repo");
	const bin = resolve(root, "bin");
	const logPath = resolve(root, "invocations.log");
	await mkdir(repo);
	await mkdir(bin);
	await writeFile(resolve(repo, "git.exe"), "planted git\n");
	await writeFile(resolve(repo, "ssh.exe"), "planted ssh\n");
	const recorder = resolve(bin, "git");
	execFileSync("gcc", ["-O2", "-o", recorder, recorderSource], { stdio: "inherit" });
	await symlink(recorder, resolve(bin, "ssh"));
	return {
		repo,
		bin,
		logPath,
		cleanup: () => rm(root, { recursive: true, force: true })
	};
}

async function withRecorderEnv(fixture, run) {
	const previousPath = process.env.PATH;
	const previousLog = process.env.INVOCATION_LOG;
	const previousRemote = process.env.GIT_REMOTE_URL;
	process.env.PATH = `${fixture.bin}${delimiter}${previousPath ?? ""}`;
	process.env.INVOCATION_LOG = fixture.logPath;
	process.env.GIT_REMOTE_URL = plantedRemote;
	try {
		await run();
	} finally {
		restoreEnv("PATH", previousPath);
		restoreEnv("INVOCATION_LOG", previousLog);
		restoreEnv("GIT_REMOTE_URL", previousRemote);
	}
}

function restoreEnv(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function readInvocations(logPath) {
	let text = "";
	try {
		text = await readFile(logPath, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const invocations = [];
	let current = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("ARGV0=")) current = { argv0: line.slice("ARGV0=".length), cwd: "", args: [] };
		else if (current && line.startsWith("CWD=")) current.cwd = line.slice("CWD=".length);
		else if (current && line.startsWith("ARG=")) current.args.push(line.slice("ARG=".length));
		else if (line === "END" && current) {
			invocations.push(current);
			current = null;
		}
	}
	return invocations;
}
