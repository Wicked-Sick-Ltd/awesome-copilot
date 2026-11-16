import fs from "fs";
import path from "path";

const SCANNED_EXTENSIONS = new Set([".md", ".sh", ".bash", ".zsh"]);

const FETCH = String.raw`\b(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod|irm)\b`;
const SUDO = String.raw`\bsudo(?:\s+-\S+(?:\s+[^-\s|;&]\S*)?)*`;
const SHELL = String.raw`(?:env\s+(?:\S+=\S*\s+)*)?(?:/(?:usr/)?bin/)?(?:ba|z|da|k|c|tc|fi)?sh\b`;
const ROOT_SHELL = `${SUDO}\\s+${SHELL}`;

const ROOT_REMOTE_SCRIPT_PATTERNS = [
  // curl … | sudo bash, curl … | sudo -E sh -s -- args
  new RegExp(`${FETCH}[^\\n]*\\|\\s*${ROOT_SHELL}`, "i"),
  // curl … | sudo -s
  new RegExp(`${FETCH}[^\\n]*\\|\\s*\\bsudo\\s+-[is]\\s*(?:$|[;&#)])`, "i"),
  // sudo bash -c "$(curl …)", sudo bash <(curl …)
  new RegExp(`${ROOT_SHELL}[^\\n]*(?:\\$|<)\\(\\s*${FETCH}`, "i"),
];

function toLogicalLines(text) {
  const physical = text.split(/\r?\n/);
  const logical = [];
  for (let i = 0; i < physical.length; i++) {
    const start = i;
    let line = physical[i];
    while (/(?:\\|\|)\s*$/.test(line) && i + 1 < physical.length) {
      line = line.replace(/\\\s*$/, " ") + " " + physical[++i];
    }
    logical.push({ line: start + 1, text: line });
  }
  return logical;
}

/**
 * Find commands that download a script and run it as root without a pinned
 * version or checksum, e.g. `curl -sL https://… | sudo bash`.
 */
export function findRootRemoteScriptExecutions(text) {
  return toLogicalLines(text)
    .filter(({ text: line }) =>
      ROOT_REMOTE_SCRIPT_PATTERNS.some((pattern) => pattern.test(line))
    )
    .map(({ line, text: command }) => ({ line, command: command.trim() }));
}

function listScannedFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listScannedFiles(entryPath));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
}

export function findRootRemoteScriptExecutionsInFolder(folderPath) {
  const findings = [];
  for (const file of listScannedFiles(folderPath)) {
    const text = fs.readFileSync(file, "utf8");
    for (const finding of findRootRemoteScriptExecutions(text)) {
      findings.push({
        file: path.relative(folderPath, file).split(path.sep).join("/"),
        ...finding,
      });
    }
  }
  return findings;
}
