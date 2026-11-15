// Spec for notebook cell signal isolation.
// Cells run through the real canvas runner (open/add/update then run_cell or run_all).
// These tests fail while a cell can signal another process, and pass once it cannot.
//
// Covered calls: os.kill, os.killpg, signal.pthread_kill, signal.pidfd_send_signal,
// and signal.raise_signal. CPython 3.12 exposes pidfd_send_signal on the signal
// module; os.pidfd_send_signal is not present. The Windows TerminateProcess
// branch of os.kill is not executed here.
//
// Run: node --test extensions/jupyter-notebooks/signal-isolation.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvasSourcePath = path.join(here, "notebook-canvas.mjs");

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function processGroup(pid) {
    const result = spawnSync("python3", ["-c", "import os, sys; print(os.getpgid(int(sys.argv[1])))", String(pid)], {
        encoding: "utf8",
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || `Unable to read process group for ${pid}`);
    }
    return Number(result.stdout.trim());
}

function notebookDocument(source) {
    return JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
            language_info: { name: "python", file_extension: ".py", mimetype: "text/x-python" },
        },
        cells: [{
            cell_type: "code",
            id: "cell-attack01",
            metadata: {},
            execution_count: null,
            outputs: [],
            source,
        }],
    });
}

function attackSource(kind, victimPid) {
    const reloadOs = "import importlib, os, signal\nos = importlib.reload(os)\n";
    const target = victimPid ?? "os.getppid()";
    switch (kind) {
        case "print":
            return 'print("runner-ok")\n';
        case "fork":
            return "import importlib, os\nos = importlib.reload(os)\nos.fork()\nprint('SIGNAL_SENT')\n";
        case "kill":
            return `${reloadOs}os.kill(${target}, signal.SIGKILL)\nprint("SIGNAL_SENT")\n`;
        case "killpg":
            return `${reloadOs}os.killpg(${target}, signal.SIGKILL)\nprint("SIGNAL_SENT")\n`;
        case "pthread_kill":
            return "import importlib, signal, threading\nsignal = importlib.reload(signal)\nsignal.pthread_kill(threading.get_ident(), signal.SIGKILL)\nprint('SIGNAL_SENT')\n";
        case "pidfd":
            return `${reloadOs}signal = importlib.reload(signal)\nfd = os.pidfd_open(${target})\nsignal.pidfd_send_signal(fd, signal.SIGKILL)\nprint("SIGNAL_SENT")\n`;
        case "raise_signal":
            return "import importlib, signal\nsignal = importlib.reload(signal)\nsignal.raise_signal(signal.SIGKILL)\nprint('SIGNAL_SENT')\n";
        default:
            throw new Error(`Unknown attack kind ${kind}`);
    }
}

const sdkStub = `export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CanvasError";
    }
}
export function createCanvas(definition) {
    return definition;
}
export async function joinSession() {
    return { workspacePath: process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE };
}
`;

async function loadCanvas(workspace) {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-canvas-load-"));
    const stubDir = path.join(dir, "node_modules", "@github", "copilot-sdk");
    await mkdir(stubDir, { recursive: true });
    await writeFile(path.join(stubDir, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk",
        type: "module",
        exports: { "./extension": "./extension.mjs" },
    }));
    await writeFile(path.join(stubDir, "extension.mjs"), sdkStub);
    const source = await readFile(canvasSourcePath, "utf8");
    await writeFile(path.join(dir, "notebook-canvas.mjs"), `${source}\nexport { handleCanvasAction };\n`);
    process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE = workspace;
    const loaded = await import(pathToFileURL(path.join(dir, "notebook-canvas.mjs")).href);
    return { handleCanvasAction: loaded.handleCanvasAction, dir };
}

function cellReport(notebook) {
    const cell = notebook.cells[notebook.cells.length - 1];
    const outputs = cell.outputs ?? [];
    const error = outputs.find((output) => output.output_type === "error");
    const stdout = outputs
        .filter((output) => output.output_type === "stream" && output.name === "stdout")
        .map((output) => output.text)
        .join("");
    return {
        ename: error?.ename ?? null,
        evalue: error?.evalue ?? null,
        stdout,
    };
}

async function executeCell(workspace, entry, source) {
    const { handleCanvasAction, dir } = await loadCanvas(workspace);
    try {
        const ctx = { instanceId: "signal-isolation" };
        if (entry === "add_cell") {
            const added = await handleCanvasAction(ctx, "add_cell", { cellType: "code", source });
            const ran = await handleCanvasAction(ctx, "run_cell", { cellId: added.cellId });
            return cellReport(ran.notebook);
        }
        const initial = entry === "update_cell" ? "print('placeholder')\n" : source;
        await writeFile(path.join(workspace, "attack.ipynb"), notebookDocument(initial));
        const opened = await handleCanvasAction(ctx, "open_workspace", { path: "attack.ipynb" });
        const cellId = opened.notebook.cells[0].id;
        if (entry === "update_cell") {
            await handleCanvasAction(ctx, "update_cell", { cellId, source });
        }
        const ran = entry === "run_all"
            ? await handleCanvasAction(ctx, "run_all", {})
            : await handleCanvasAction(ctx, "run_cell", { cellId });
        return cellReport(ran.notebook);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

async function hostMain() {
    const workspace = process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE;
    const entry = process.env.NOTEBOOK_SIGNAL_ENTRY;
    const kind = process.env.NOTEBOOK_SIGNAL_KIND;
    const victimPid = process.env.NOTEBOOK_SIGNAL_VICTIM || null;
    const source = attackSource(kind, victimPid);
    try {
        const report = await executeCell(workspace, entry, source);
        process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({
            ok: false,
            name: error?.name ?? null,
            code: error?.code ?? null,
            message: error?.message ?? String(error),
        })}\n`);
    }
}

function runHost(workspace, entry, kind, victimPid) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: workspace,
                LANG: "C.UTF-8",
                NOTEBOOK_SIGNAL_HOST: "1",
                NOTEBOOK_CANVAS_TEST_WORKSPACE: workspace,
                NOTEBOOK_SIGNAL_ENTRY: entry,
                NOTEBOOK_SIGNAL_KIND: kind,
                NOTEBOOK_SIGNAL_VICTIM: victimPid ? String(victimPid) : "",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

function parseHost(result) {
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) {
        return null;
    }
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

async function withWorkspace(fn) {
    const workspace = await mkdtemp(path.join(tmpdir(), "notebook-signal-workspace-"));
    try {
        return await fn(workspace);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

function startVictim() {
    const victim = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
    victim.unref();
    const ownGroup = processGroup(process.pid);
    const victimGroup = processGroup(victim.pid);
    assert.notEqual(victimGroup, ownGroup, "Refusing to signal a process in this test's process group.");
    assert.equal(victimGroup, victim.pid);
    return victim;
}

function assertRunnerDenied(result, eventName) {
    assert.equal(result.signal, null, `Host was signaled (${result.signal}). stderr=${result.stderr}`);
    assert.equal(result.code, 0, `Host exited ${result.code}. stderr=${result.stderr} stdout=${result.stdout}`);
    const body = parseHost(result);
    assert.ok(body, `Host returned no JSON. stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(body.ok, true, `Runner failed closed at the process boundary: ${body.message ?? result.stderr}`);
    assert.equal(body.stdout.includes("SIGNAL_SENT"), false, body.stdout);
    assert.equal(body.ename, "PermissionError");
    assert.match(body.evalue, new RegExp(`${eventName.replace(".", "\\.")} is disabled in notebook execution`));
}

function assertSignalDidNotLand(result, victimPid) {
    assert.equal(result.signal, null, `Host was signaled (${result.signal}). stderr=${result.stderr}`);
    assert.equal(result.code, 0, `Host exited ${result.code}. stderr=${result.stderr} stdout=${result.stdout}`);
    if (victimPid !== undefined) {
        assert.equal(processAlive(victimPid), true, `Victim ${victimPid} was signaled.`);
    }
    const body = parseHost(result);
    assert.ok(body, `Host returned no JSON. stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(body.ok, true, `Runner process died while handling the cell: ${body.code ?? ""} ${body.message ?? ""}`);
    assert.equal(body.stdout.includes("SIGNAL_SENT"), false, body.stdout);
    assert.ok(body.ename, "Cell completed without an error after requesting a signal.");
}

if (process.env.NOTEBOOK_SIGNAL_HOST === "1") {
    await hostMain();
} else {
    test("a normal cell still prints through the isolated runner", async () => {
        await withWorkspace(async (workspace) => {
            const result = await runHost(workspace, "workspace", "print");
            assert.equal(result.signal, null, result.stderr);
            assert.equal(result.code, 0, result.stderr);
            const body = parseHost(result);
            assert.ok(body?.ok, result.stdout + result.stderr);
            assert.equal(body.ename, null, body.evalue);
            assert.match(body.stdout, /runner-ok/);
        });
    });

    test("os.fork from a workspace notebook stays denied", async () => {
        await withWorkspace(async (workspace) => {
            const result = await runHost(workspace, "workspace", "fork");
            assertRunnerDenied(result, "os.fork");
        });
    });

    const parentKillEntries = [
        ["workspace", "a workspace notebook cell cannot SIGKILL the canvas host with os.kill"],
        ["add_cell", "add_cell source cannot SIGKILL the canvas host with os.kill"],
        ["update_cell", "update_cell source cannot SIGKILL the canvas host with os.kill"],
        ["run_all", "run_all cannot SIGKILL the canvas host with os.kill"],
    ];
    for (const [entry, name] of parentKillEntries) {
        test(name, async () => {
            await withWorkspace(async (workspace) => {
                const result = await runHost(workspace, entry, "kill");
                assertRunnerDenied(result, "os.kill");
            });
        });
    }

    test("a notebook cell cannot SIGKILL another process the user owns with os.kill", async () => {
        const victim = startVictim();
        try {
            await withWorkspace(async (workspace) => {
                const result = await runHost(workspace, "workspace", "kill", victim.pid);
                assert.equal(processAlive(victim.pid), true);
                assertRunnerDenied(result, "os.kill");
            });
        } finally {
            if (processAlive(victim.pid)) {
                process.kill(victim.pid, "SIGKILL");
            }
        }
    });

    test("a notebook cell cannot SIGKILL another process group with os.killpg", async () => {
        const victim = startVictim();
        try {
            await withWorkspace(async (workspace) => {
                const result = await runHost(workspace, "workspace", "killpg", victim.pid);
                assert.equal(processAlive(victim.pid), true);
                assertRunnerDenied(result, "os.killpg");
            });
        } finally {
            if (processAlive(victim.pid)) {
                process.kill(victim.pid, "SIGKILL");
            }
        }
    });

    test("a notebook cell cannot pthread_kill its runner thread", async () => {
        await withWorkspace(async (workspace) => {
            const result = await runHost(workspace, "workspace", "pthread_kill");
            assertRunnerDenied(result, "signal.pthread_kill");
        });
    });

    test("a notebook cell cannot pidfd_send_signal the canvas host", async () => {
        await withWorkspace(async (workspace) => {
            const result = await runHost(workspace, "workspace", "pidfd");
            assertSignalDidNotLand(result);
        });
    });

    test("a notebook cell cannot pidfd_send_signal another process the user owns", async () => {
        const victim = startVictim();
        try {
            await withWorkspace(async (workspace) => {
                const result = await runHost(workspace, "workspace", "pidfd", victim.pid);
                assertSignalDidNotLand(result, victim.pid);
            });
        } finally {
            if (processAlive(victim.pid)) {
                process.kill(victim.pid, "SIGKILL");
            }
        }
    });

    test("a notebook cell cannot raise_signal SIGKILL inside the runner", async () => {
        await withWorkspace(async (workspace) => {
            const result = await runHost(workspace, "workspace", "raise_signal");
            assertSignalDidNotLand(result);
        });
    });
}
