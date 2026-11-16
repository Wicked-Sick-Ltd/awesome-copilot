#!/usr/bin/env node
// Installs one pinned, integrity-checked release of the WorkIQ CLI.
// To move to a newer release, update WORKIQ_VERSION and WORKIQ_INTEGRITY together,
// taking the integrity from `npm view @microsoft/workiq@<version> dist.integrity`
// and checking it against a tarball you have reviewed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKIQ_PACKAGE = "@microsoft/workiq";
export const WORKIQ_VERSION = "1.0.1";
export const WORKIQ_INTEGRITY =
  "sha512-syOh4Py5hR3rh7kRHzYipxU2tJMzUfu7VBJ5bTzXCEh2S0BXVCZVu6TWmFYMmkTk8QEreMaqPMWQEy4aMBd/Xg==";

function npm(args, env) {
  const isWindows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    // npm.cmd can only be started through a shell on Windows.
    const child = spawn(
      isWindows ? "npm.cmd" : "npm",
      isWindows ? args.map((arg) => `"${arg}"`) : args,
      { env, shell: isWindows, stdio: ["ignore", "pipe", "inherit"] }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`npm ${args[0]} exited with code ${code}`));
    });
  });
}

export async function installVerifiedPackage({ name, version, integrity, env = process.env }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-install-"));
  try {
    const downloadDir = path.join(workDir, "download");
    fs.mkdirSync(downloadDir);
    await npm(
      ["pack", `${name}@${version}`, "--ignore-scripts", "--loglevel", "warn", "--pack-destination", downloadDir],
      env
    );

    const tarballs = fs.readdirSync(downloadDir).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`expected one tarball for ${name}@${version}, found ${tarballs.length}`);
    }
    const bytes = fs.readFileSync(path.join(downloadDir, tarballs[0]));
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (actual !== integrity) {
      throw new Error(
        `integrity mismatch for ${name}@${version}: expected ${integrity}, got ${actual}. Nothing was installed.`
      );
    }

    // Install the bytes that were hashed, not whatever is at the download path now.
    const verified = path.join(workDir, "verified.tgz");
    fs.writeFileSync(verified, bytes, { flag: "wx", mode: 0o600 });
    await npm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", verified], env);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installVerifiedPackage({
    name: WORKIQ_PACKAGE,
    version: WORKIQ_VERSION,
    integrity: WORKIQ_INTEGRITY,
  }).then(
    () => console.log(`Installed ${WORKIQ_PACKAGE}@${WORKIQ_VERSION} (${WORKIQ_INTEGRITY}).`),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
