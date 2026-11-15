import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// The canvas module calls joinSession at import. Register the stub first.
const workspaceRoot = await mkdtemp(path.join(tmpdir(), "notebook-canvas-workspace-"));
process.env.NOTEBOOK_CANVAS_TEST_WORKSPACE = workspaceRoot;
register("./test-support/sdk-loader.mjs", import.meta.url);
await import("./notebook-canvas.mjs");

const canvas = globalThis.__notebookCanvasUnderTest;
const SENTINEL = "NATIVE_SANDBOX_ESCAPE_SENTINEL";

function action(name) {
    const found = canvas.actions.find((candidate) => candidate.name === name);
    if (!found) {
        throw new Error(`Missing canvas action ${name}`);
    }
    return found;
}

function invoke(name, notebookId, input = {}) {
    return action(name).handler({
        instanceId: "native-extension-sandbox",
        input: { notebookId, ...input },
    });
}

function outputText(notebook) {
    const chunks = [];
    for (const cell of notebook.cells) {
        for (const output of cell.outputs ?? []) {
            if (output.output_type === "stream") {
                chunks.push(String(output.text ?? ""));
            }
            if (output.output_type === "error") {
                chunks.push(`${output.ename}: ${output.evalue}`);
            }
        }
    }
    return chunks.join("\n");
}

function cellError(notebook) {
    for (const cell of notebook.cells) {
        const error = (cell.outputs ?? []).find((output) => output.output_type === "error");
        if (error) {
            return error;
        }
    }
    return null;
}

function compileExtension(moduleName, proofIn, proofOut, destination) {
    const sourcePath = `${destination}.c`;
    const source = `#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <stdio.h>

static char leaked[512];

static struct PyModuleDef moduledef = {
    PyModuleDef_HEAD_INIT,
    "${moduleName}",
    NULL,
    -1,
    NULL
};

PyMODINIT_FUNC PyInit_${moduleName}(void) {
    leaked[0] = '\\0';
    FILE *input = fopen("${proofIn}", "r");
    if (input) {
        if (!fgets(leaked, sizeof leaked, input)) {
            leaked[0] = '\\0';
        }
        fclose(input);
    }
    FILE *output = fopen("${proofOut}", "w");
    if (output) {
        fputs(leaked, output);
        fclose(output);
    }
    PyObject *module = PyModule_Create(&moduledef);
    if (module) {
        PyModule_AddStringConstant(module, "leaked", leaked);
    }
    return module;
}
`;
    return writeFile(sourcePath, source, "utf8").then(() => {
        const includes = spawnSync("python3-config", ["--includes"], { encoding: "utf8" });
        if (includes.status !== 0) {
            throw new Error(includes.stderr || "python3-config --includes failed");
        }
        const compiled = spawnSync(
            "gcc",
            ["-shared", "-fPIC", ...includes.stdout.trim().split(/\s+/), "-o", destination, sourcePath],
            { encoding: "utf8" },
        );
        if (compiled.status !== 0) {
            throw new Error(compiled.stderr || compiled.stdout || "gcc failed");
        }
    });
}

async function outsideProofs() {
    const directory = await mkdtemp(path.join(tmpdir(), "notebook-escape-"));
    const proofIn = path.join(directory, "proof-in.txt");
    const proofOut = path.join(directory, "proof-out.txt");
    await writeFile(proofIn, `${SENTINEL}\n`, "utf8");
    return { directory, proofIn, proofOut };
}

function denialPreamble(proofIn, proofOut) {
    return `
proof_in = ${JSON.stringify(proofIn)}
proof_out = ${JSON.stringify(proofOut)}
try:
    open(proof_in, "r", encoding="utf-8").read()
    print("PYTHON_OUTSIDE_READ_ALLOWED")
except PermissionError:
    print("PYTHON_OUTSIDE_READ_DENIED")
try:
    open(proof_out, "w", encoding="utf-8").write("python-write")
    print("PYTHON_OUTSIDE_WRITE_ALLOWED")
except PermissionError:
    print("PYTHON_OUTSIDE_WRITE_DENIED")
`;
}

function notebookDocument(source) {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
            language_info: { name: "python", file_extension: ".py", mimetype: "text/x-python" },
        },
        cells: [
            {
                id: "cell-attack",
                cell_type: "code",
                execution_count: null,
                metadata: {},
                outputs: [],
                source,
            },
        ],
    };
}

async function openAndRun(notebookId, source, actionName) {
    const relativePath = `${notebookId}.ipynb`;
    await writeFile(
        path.join(workspaceRoot, relativePath),
        `${JSON.stringify(notebookDocument(source), null, 2)}\n`,
        "utf8",
    );
    await invoke("open_workspace", notebookId, { path: relativePath });
    const run = await invoke(actionName, notebookId, actionName === "run_cell" ? { cellId: "cell-attack" } : {});
    return run.notebook;
}

async function assertNativeLoadRefused(notebook, proofOut) {
    const text = outputText(notebook);
    const error = cellError(notebook);
    let outside = null;
    try {
        outside = await readFile(proofOut, "utf8");
    } catch (readError) {
        if (readError?.code !== "ENOENT") {
            throw readError;
        }
    }
    assert.equal(
        outside,
        null,
        `Native module init must not create ${proofOut} before the runner refuses.\n${text}`,
    );
    assert.match(text, /PYTHON_OUTSIDE_READ_DENIED/, text);
    assert.match(text, /PYTHON_OUTSIDE_WRITE_DENIED/, text);
    assert.doesNotMatch(text, /PYTHON_OUTSIDE_READ_ALLOWED/);
    assert.doesNotMatch(text, /PYTHON_OUTSIDE_WRITE_ALLOWED/);
    assert.doesNotMatch(text, new RegExp(SENTINEL), text);
    assert.ok(error, `Cell must be refused.\n${text}`);
    assert.equal(error.ename, "PermissionError", text);
}

test("run_cell refuses a shared library imported from the workspace sys.path", async (t) => {
    const proofs = await outsideProofs();
    t.after(() => rm(proofs.directory, { recursive: true, force: true }));
    const built = path.join(proofs.directory, "nbescape1.so");
    await compileExtension("nbescape1", proofs.proofIn, proofs.proofOut, built);
    const bytes = (await readFile(built)).toString("base64");
    const source = `${denialPreamble(proofs.proofIn, proofs.proofOut)}
import base64, pathlib, sys
from importlib.machinery import EXTENSION_SUFFIXES
target = pathlib.Path("nbescape1" + EXTENSION_SUFFIXES[0])
target.write_bytes(base64.b64decode(${JSON.stringify(bytes)}))
sys.path.insert(0, str(pathlib.Path.cwd()))
import nbescape1
print("NATIVE_LEAK", nbescape1.leaked)
`;
    const notebook = await openAndRun("import-suffix", source, "run_cell");
    await assertNativeLoadRefused(notebook, proofs.proofOut);
});

test("run_all refuses ExtensionFileLoader on a workspace file that is not named as a shared library", async (t) => {
    const proofs = await outsideProofs();
    t.after(() => rm(proofs.directory, { recursive: true, force: true }));
    const built = path.join(proofs.directory, "nbescape2.so");
    await compileExtension("nbescape2", proofs.proofIn, proofs.proofOut, built);
    const bytes = (await readFile(built)).toString("base64");
    const source = `${denialPreamble(proofs.proofIn, proofs.proofOut)}
import base64, pathlib
from importlib.machinery import ExtensionFileLoader
from importlib.util import module_from_spec, spec_from_file_location
target = pathlib.Path.cwd() / "nbescape2.payload"
target.write_bytes(base64.b64decode(${JSON.stringify(bytes)}))
loader = ExtensionFileLoader("nbescape2", str(target))
spec = spec_from_file_location("nbescape2", str(target), loader=loader)
module = module_from_spec(spec)
spec.loader.exec_module(module)
print("NATIVE_LEAK", module.leaked)
`;
    const notebook = await openAndRun("loader-unsuffixed", source, "run_all");
    await assertNativeLoadRefused(notebook, proofs.proofOut);
});

test("run_cell refuses ExtensionFileLoader.load_module for a cell edited in the canvas", async (t) => {
    const proofs = await outsideProofs();
    t.after(() => rm(proofs.directory, { recursive: true, force: true }));
    const built = path.join(proofs.directory, "nbescape3.so");
    await compileExtension("nbescape3", proofs.proofIn, proofs.proofOut, built);
    const bytes = (await readFile(built)).toString("base64");
    const notebookId = "edited-load-module";
    const created = await invoke("get_notebook", notebookId);
    const cellId = created.notebook.cells[0].id;
    const source = `${denialPreamble(proofs.proofIn, proofs.proofOut)}
import base64, pathlib
from importlib.machinery import ExtensionFileLoader
target = pathlib.Path.cwd() / "nbescape3.payload"
target.write_bytes(base64.b64decode(${JSON.stringify(bytes)}))
module = ExtensionFileLoader("nbescape3", str(target)).load_module("nbescape3")
print("NATIVE_LEAK", module.leaked)
`;
    await invoke("update_cell", notebookId, { cellId, source });
    const run = await invoke("run_cell", notebookId, { cellId });
    await assertNativeLoadRefused(run.notebook, proofs.proofOut);
});

test.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
});
