# Jupyter Notebooks

Create, edit, run, save, and checkpoint Jupyter notebooks in an interactive GitHub Copilot canvas.

![Jupyter Notebooks canvas showing Markdown, Python code, and execution output](assets/preview.png)

## What it does

- Opens existing `.ipynb` files from the current workspace.
- Creates code, Markdown, and raw cells with reorder, duplicate, undo, and redo controls.
- Runs Python cells through a fresh isolated process with bounded resources and captured rich output.
- Saves, renames, and duplicates notebooks as standard `.ipynb` files.
- Creates persistent checkpoints that can be restored from the canvas.

## Requirements

- Python 3 available as `python3` or `python`.
- The `@github/copilot-sdk` package installed with the extension.

## Install

Ask Copilot to install the committed extension:

```text
Install this extension: https://github.com/github/awesome-copilot/tree/main/extensions/jupyter-notebooks
```

Reload extensions, then ask Copilot to open the `jupyter-notebooks` canvas.

## Agent actions

The canvas provides actions for notebook lifecycle, workspace files, cell editing, execution, runtime selection, and checkpoints. Use `get_notebook` to inspect the current state before editing a cell.

## Security and local data

Notebook execution uses Python isolated mode in a fresh temporary directory. Before any cell runs, the operating system is told to refuse process creation for the runner: a seccomp filter on Linux (x86_64 and aarch64) denies `fork`, `vfork`, `execve`, `execveat`, and non-thread `clone`; a job object limited to one active process is used on Windows; and a sandbox profile denying `process-fork` and `process-exec` is applied on macOS. If that lock cannot be applied, cells are not run. The runner also applies CPU, file-size, and open-file limits where the platform supports them, caps captured output, and stops execution after 30 seconds.

The local canvas server binds to `127.0.0.1`, protects requests with a per-instance capability token, validates action origins, and sends a restrictive content security policy. Notebook state and checkpoints stay in the active Copilot workspace.
