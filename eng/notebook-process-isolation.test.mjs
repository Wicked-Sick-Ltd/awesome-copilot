// Host-effect tests for notebook cell process isolation.
//
// Run from the repository root:
//   node --test eng/notebook-process-isolation.test.mjs
//
// These tests fail while a code cell can start a host executable. They pass
// when the runner stops that executable from creating a file outside the
// cell process and from leaving a process behind.
//
// Covered process-creation paths:
//   _posixsubprocess.fork_exec imported directly, including an argv of /usr/bin/touch
//   _posixsubprocess.fork_exec taken from sys.modules after import subprocess
//   os.execv, os.execve, and the os.execl / os.execvp wrappers
//   a workspace .ipynb whose source is a JSON array of lines
//   run_cell and run_all
//   _winapi.CreateProcess on Windows only
//
// os.execle, os.execlp, os.execlpe, and os.execvpe are not separate cases.
// In CPython 3.12 they call os.execv or os.execve, which are tested here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const workspace = await mkdtemp(path.join(tmpdir(), "notebook-canvas-workspace-"));
process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE = workspace;
register(new URL("./notebook-process-isolation.loader.mjs", import.meta.url), import.meta.url);
const { handleCanvasAction } = await import("../extensions/jupyter-notebooks/notebook-canvas.mjs");

test.after(async () => {
    await rm(workspace, { recursive: true, force: true });
});

function forkExecCall(command, accessor) {
    return `
${accessor}
err_r, err_w = os.pipe()
pid = fork_exec(
    ["/bin/sh", "-c", ${JSON.stringify(command)}],
    (b"/bin/sh",),
    True,
    (err_w,),
    None,
    None,
    -1, -1, -1, -1, -1, -1,
    err_r, err_w,
    False,
    False,
    -1,
    None,
    None,
    None,
    -1,
    None,
    False,
)
print("SPAWN_RETURNED", pid)
`;
}

function touchForkExec(marker) {
    return `
import os
import _posixsubprocess
err_r, err_w = os.pipe()
pid = _posixsubprocess.fork_exec(
    ["/usr/bin/touch", ${JSON.stringify(marker)}],
    (b"/usr/bin/touch",),
    True,
    (err_w,),
    None,
    None,
    -1, -1, -1, -1, -1, -1,
    err_r, err_w,
    False,
    False,
    -1,
    None,
    None,
    None,
    -1,
    None,
    False,
)
print("SPAWN_RETURNED", pid)
`;
}

function directForkExec(marker, pidfile) {
    const command = `exec >/dev/null 2>&1; echo escaped > ${marker}; echo $$ > ${pidfile}; exec sleep 120`;
    return forkExecCall(command, "import os\nimport _posixsubprocess\nfork_exec = _posixsubprocess.fork_exec");
}

function forkExecAfterSubprocess(marker, pidfile) {
    const command = `exec >/dev/null 2>&1; echo escaped > ${marker}; echo $$ > ${pidfile}; exec sleep 120`;
    return forkExecCall(command, `
import os, subprocess, sys
try:
    subprocess.Popen(["/bin/true"])
except PermissionError:
    pass
fork_exec = sys.modules["_posixsubprocess"].fork_exec
`);
}

function execSource(kind, marker) {
    const command = `echo escaped > ${marker}`;
    if (kind === "execv") {
        return `
import os
os.execv("/bin/sh", ["sh", "-c", ${JSON.stringify(command)}])
`;
    }
    if (kind === "execve") {
        return `
import os
os.execve("/bin/sh", ["sh", "-c", ${JSON.stringify(command)}], dict(os.environ))
`;
    }
    if (kind === "execl") {
        return `
import os
os.execl("/bin/sh", "sh", "-c", ${JSON.stringify(command)})
`;
    }
    if (kind === "execvp") {
        return `
import os
os.execvp("sh", ["sh", "-c", ${JSON.stringify(command)}])
`;
    }
    throw new Error(`unknown exec kind ${kind}`);
}

function createProcessSource(marker) {
    const command = `cmd.exe /c echo escaped> ${marker}`;
    return `
import subprocess, sys
try:
    subprocess.Popen(["cmd.exe", "/c", "exit", "0"])
except PermissionError:
    pass
winapi = sys.modules.get("_winapi")
if winapi is None:
    import _winapi as winapi
info = subprocess.STARTUPINFO()
created = winapi.CreateProcess(None, ${JSON.stringify(command)}, None, None, 0, 0, None, None, info)
print("SPAWN_RETURNED", created[2])
`;
}

function containedSource(marker) {
    const command = `echo escaped > ${marker}`;
    return `
import os, subprocess
command = ${JSON.stringify(command)}
try:
    subprocess.Popen(["/bin/sh", "-c", command])
except PermissionError:
    print("DENIED subprocess")
try:
    os.system(command)
except PermissionError:
    print("DENIED os.system")
try:
    os.posix_spawn("/bin/sh", ["sh", "-c", command], dict(os.environ))
except PermissionError:
    print("DENIED os.posix_spawn")
try:
    os.spawnv(os.P_WAIT, "/bin/sh", ["sh", "-c", command])
except PermissionError:
    print("DENIED os.spawnv")
try:
    os.fork()
except PermissionError:
    print("DENIED os.fork")
`;
}

function notebookDocument(sourceLines) {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
            language_info: { name: "python", file_extension: ".py", mimetype: "text/x-python" },
        },
        cells: [{
            cell_type: "code",
            id: "cell-workspace01",
            metadata: {},
            execution_count: null,
            outputs: [],
            source: sourceLines,
        }],
    };
}

function sourceLines(source) {
    const lines = source.split("\n");
    return lines.map((line, index) => (index === lines.length - 1 ? line : `${line}\n`));
}

async function readText(file) {
    try {
        return await readFile(file, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

function pidsMentioning(token) {
    const listed = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    const pids = [];
    for (const line of listed.stdout.split("\n")) {
        if (!line.includes(token)) {
            continue;
        }
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
            pids.push(pid);
        }
    }
    return pids;
}

async function cleanupEscape(marker, pidfile) {
    const pids = new Set(pidsMentioning(marker));
    const recorded = await readText(pidfile);
    if (recorded) {
        for (const part of recorded.trim().split(/\s+/)) {
            const pid = Number(part);
            if (Number.isInteger(pid) && pid > 1) {
                pids.add(pid);
            }
        }
    }
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // The process already exited.
        }
    }
}

async function hostEffects(marker, pidfile) {
    const deadline = Date.now() + 2000;
    let markerText = null;
    let survivors = [];
    do {
        markerText = await readText(marker);
        survivors = pidsMentioning(marker);
        const recorded = await readText(pidfile);
        if (recorded) {
            const pid = Number(recorded.trim());
            if (Number.isInteger(pid) && pid > 1) {
                try {
                    process.kill(pid, 0);
                    survivors.push(pid);
                } catch {
                    // The recorded process is gone.
                }
            }
        }
        if (markerText !== null || survivors.length > 0) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return { markerText, survivors: [...new Set(survivors)] };
}

function outputText(result) {
    if (!result?.notebook?.cells) {
        return "";
    }
    return result.notebook.cells.map((cell) => JSON.stringify(cell.outputs ?? [])).join("\n");
}

async function runUpdatedCell(notebookId, source, action) {
    const ctx = { instanceId: `instance-${notebookId}`, notebookId };
    const current = await handleCanvasAction(ctx, "get_notebook", {});
    const cell = current.notebook.cells.find((entry) => entry.cellType === "code");
    await handleCanvasAction(ctx, "update_cell", { cellId: cell.id, source });
    try {
        const result = await handleCanvasAction(
            ctx,
            action,
            action === "run_cell" ? { cellId: cell.id } : {},
        );
        return { result, error: null };
    } catch (error) {
        if (error?.code === "python_not_found") {
            throw error;
        }
        return { result: null, error };
    }
}

async function runWorkspaceNotebook(notebookId, source) {
    const ctx = { instanceId: `instance-${notebookId}`, notebookId };
    const relative = `${notebookId}.ipynb`;
    await writeFile(
        path.join(workspace, relative),
        JSON.stringify(notebookDocument(sourceLines(source))),
        "utf8",
    );
    await handleCanvasAction(ctx, "open_workspace", { path: relative });
    const opened = await handleCanvasAction(ctx, "get_notebook", {});
    const cell = opened.notebook.cells.find((entry) => entry.cellType === "code");
    try {
        const result = await handleCanvasAction(ctx, "run_cell", { cellId: cell.id });
        return { result, error: null, source: cell.source };
    } catch (error) {
        if (error?.code === "python_not_found") {
            throw error;
        }
        return { result: null, error, source: cell.source };
    }
}

function assertContained(outcome, effects) {
    const detail = [
        outcome.error ? `${outcome.error.code || outcome.error.name}: ${outcome.error.message}` : "",
        outputText(outcome.result),
        effects.markerText === null ? "" : `marker=${JSON.stringify(effects.markerText)}`,
        effects.survivors.length === 0 ? "" : `pids=${effects.survivors.join(",")}`,
    ].filter(Boolean).join("\n");
    assert.equal(effects.markerText, null, `cell created a host file\n${detail}`);
    assert.deepEqual(effects.survivors, [], `cell left a host process running\n${detail}`);
    assert.equal(
        `${outputText(outcome.result)}\n${outcome.error?.message || ""}`.includes("SPAWN_RETURNED"),
        false,
        `cell process helper returned\n${detail}`,
    );
}

async function withEscape(t, body) {
    const directory = await mkdtemp(path.join(tmpdir(), "notebook-cell-escape-"));
    const marker = path.join(directory, "marker");
    const pidfile = path.join(directory, "pid");
    t.after(() => cleanupEscape(marker, pidfile).then(() => rm(directory, { recursive: true, force: true })));
    await body({ marker, pidfile });
}

test("run_cell does not let _posixsubprocess.fork_exec start a host process", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("fork-exec-direct", directForkExec(marker, pidfile), "run_cell");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_cell does not let fork_exec start /usr/bin/touch", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("fork-exec-touch", touchForkExec(marker), "run_cell");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_cell does not let fork_exec run after subprocess is imported", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell(
            "fork-exec-after-subprocess",
            forkExecAfterSubprocess(marker, pidfile),
            "run_cell",
        );
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_cell does not let os.execv replace the cell process", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("os-execv", execSource("execv", marker), "run_cell");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_all does not let os.execve replace the cell process", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("os-execve", execSource("execve", marker), "run_all");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_cell does not let os.execl replace the cell process", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("os-execl", execSource("execl", marker), "run_cell");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_cell does not let os.execvp replace the cell process", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("os-execvp", execSource("execvp", marker), "run_cell");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("a workspace notebook does not let fork_exec start a host process", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runWorkspaceNotebook("workspace-notebook", directForkExec(marker, pidfile));
        assert.equal(outcome.source.includes("fork_exec"), true);
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test("run_cell keeps subprocess, posix_spawn, spawn, and fork from touching the host", async (t) => {
    await withEscape(t, async ({ marker, pidfile }) => {
        const outcome = await runUpdatedCell("documented-denylist", containedSource(marker), "run_cell");
        assertContained(outcome, await hostEffects(marker, pidfile));
    });
});

test(
    "run_cell does not let _winapi.CreateProcess start a host process",
    { skip: process.platform === "win32" ? false : "_winapi.CreateProcess is only present on Windows" },
    async (t) => {
        await withEscape(t, async ({ marker, pidfile }) => {
            const outcome = await runUpdatedCell("winapi-create-process", createProcessSource(marker), "run_cell");
            assertContained(outcome, await hostEffects(marker, pidfile));
        });
    },
);
