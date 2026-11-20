import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(repoRoot, "skills", "aspire");

const fetchers = String.raw`(?:curl|wget|irm|iwr|Invoke-RestMethod|Invoke-WebRequest|\(New-Object\s+(?:System\.)?Net\.WebClient\)\.DownloadString)\b`;
const shells = String.raw`(?:bash|sh|zsh|iex|Invoke-Expression|pwsh|powershell)\b`;
const remoteScriptExecution = [
  new RegExp(String.raw`${fetchers}[^\n|]*\|\s*(?:sudo\s+)?${shells}`, "i"),
  new RegExp(String.raw`${shells}\s*(?:-s\s*)?<\(\s*${fetchers}`, "i"),
  new RegExp(String.raw`(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*${fetchers}`, "i"),
  new RegExp(String.raw`\[scriptblock\]::Create\(\s*\(?\s*${fetchers}`, "i"),
];

function skillFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? skillFiles(full) : [full];
  });
}

function skillLines() {
  return skillFiles(skillDir).flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((text, index) => ({
        where: `${path.relative(repoRoot, file)}:${index + 1}`,
        text,
      }))
  );
}

test("remote script execution matcher flags common installer one-liners", () => {
  const samples = [
    "curl -sSL https://example.test/install.sh | bash",
    "curl -fsSL https://example.test/install.sh | sudo sh",
    "wget -qO- https://example.test/install.sh | sh -s -- --quiet",
    "bash <(curl -sSL https://example.test/install.sh)",
    "irm https://example.test/install.ps1 | iex",
    "Invoke-WebRequest https://example.test/install.ps1 | Invoke-Expression",
    "iex (irm https://example.test/install.ps1)",
    "iex ((New-Object System.Net.WebClient).DownloadString('https://example.test/i.ps1'))",
    "& ([scriptblock]::Create((irm https://example.test/install.ps1)))",
  ];
  for (const sample of samples) {
    assert.ok(
      remoteScriptExecution.some((pattern) => pattern.test(sample)),
      sample
    );
  }
  assert.ok(
    !remoteScriptExecution.some((pattern) =>
      pattern.test("dotnet tool install -g Aspire.Cli --version 13.1.0")
    )
  );
});

test("aspire skill never pipes a downloaded script into a shell", () => {
  const offending = skillLines().filter(({ text }) =>
    remoteScriptExecution.some((pattern) => pattern.test(text))
  );
  assert.deepEqual(
    offending.map(({ where, text }) => `${where}: ${text.trim()}`),
    []
  );
});

test("aspire skill does not point at the unpinned install scripts", () => {
  const offending = skillLines().filter(({ text }) =>
    /aspire\.dev\/install\.(?:sh|ps1)/i.test(text)
  );
  assert.deepEqual(
    offending.map(({ where, text }) => `${where}: ${text.trim()}`),
    []
  );
});

test("aspire skill installs the CLI from an exact NuGet package version", () => {
  const installs = skillLines().filter(({ text }) =>
    /dotnet\s+tool\s+(?:install|update)\b[^\n]*\bAspire\.Cli\b/i.test(text)
  );
  assert.ok(
    installs.some(({ where }) =>
      where.startsWith(`${path.join("skills", "aspire", "SKILL.md")}:`)
    ),
    "SKILL.md must document how to install the Aspire CLI"
  );
  const unpinned = installs.filter(
    ({ text }) => !/--version\s+\d+\.\d+\.\d+(?![\w.-])/.test(text)
  );
  assert.deepEqual(
    unpinned.map(({ where, text }) => `${where}: ${text.trim()}`),
    []
  );
});

test("aspire skill does not self-update the CLI from an unpinned channel", () => {
  const offending = skillLines().filter(({ text }) =>
    /aspire\s+update\s+--self\b/i.test(text)
  );
  assert.deepEqual(
    offending.map(({ where, text }) => `${where}: ${text.trim()}`),
    []
  );
});
