import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { ROOT_FOLDER } from "./constants.mjs";

const EXTENSION_DIR = path.join(ROOT_FOLDER, "extensions", "edit-tutorial");
const ATTACKER_VERSION = "99.0.0";

function tarHeaderField(header, offset, length, value) {
  header.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
}

function tarball(files) {
  const blocks = [];
  for (const [name, contents] of Object.entries(files)) {
    const body = Buffer.from(contents, "utf8");
    const header = Buffer.alloc(512, 0);
    tarHeaderField(header, 0, 100, `package/${name}`);
    tarHeaderField(header, 100, 8, "0000644\0");
    tarHeaderField(header, 108, 8, "0000000\0");
    tarHeaderField(header, 116, 8, "0000000\0");
    tarHeaderField(header, 124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
    tarHeaderField(header, 136, 12, "00000000000\0");
    tarHeaderField(header, 148, 8, "        ");
    tarHeaderField(header, 156, 1, "0");
    tarHeaderField(header, 257, 6, "ustar\0");
    tarHeaderField(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    tarHeaderField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function maliciousPackage(name, version) {
  const manifest = {
    name,
    version,
    main: "index.js",
    scripts: {
      preinstall:
        "node -e \"require('fs').appendFileSync(process.env.EDIT_TUTORIAL_MARKER, process.env.npm_package_name + '@' + process.env.npm_package_version + '\\n')\"",
    },
  };
  const tgz = tarball({
    "package.json": JSON.stringify(manifest),
    "index.js": "module.exports = {};\n",
  });
  const integrity = `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}`;
  const shasum = crypto.createHash("sha1").update(tgz).digest("hex");
  return { manifest, tgz, integrity, shasum };
}

// Every package and every version it serves is the attacker's: the `latest`
// dist-tag names a new attacker release, and any pinned version is answered
// with attacker bytes too, as a compromised registry or mirror would.
async function startAttackerRegistry() {
  const packages = new Map();
  const packageFor = (name, version) => {
    const key = `${name}@${version}`;
    if (!packages.has(key)) packages.set(key, maliciousPackage(name, version));
    return packages.get(key);
  };

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://registry").pathname).slice(1);
    const tarballMatch = url.match(/^(.+)\/-\/[^/]+-(\d+\.\d+\.\d+[^/]*)\.tgz$/);
    if (tarballMatch) {
      const [, name, version] = tarballMatch;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(packageFor(name, version).tgz);
      return;
    }

    const name = url;
    const base = `http://${req.headers.host}`;
    const pkg = packageFor(name, ATTACKER_VERSION);
    const tarballName = name.split("/").pop();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: ATTACKER_VERSION },
        versions: {
          [ATTACKER_VERSION]: {
            ...pkg.manifest,
            dist: {
              tarball: `${base}/${name}/-/${tarballName}-${ATTACKER_VERSION}.tgz`,
              integrity: pkg.integrity,
              shasum: pkg.shasum,
            },
          },
        },
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function documentedInstallCommands() {
  const readme = fs.readFileSync(path.join(EXTENSION_DIR, "README.md"), "utf8");
  const install = readme.match(/^## Install\n([\s\S]*?)(?=^## )/m);
  assert.ok(install, "README.md has an Install section");
  const commands = [];
  for (const block of install[1].matchAll(/```(?:sh|bash|shell)\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) {
      if (/^\s*npm\s/.test(line)) commands.push(line.trim().split(/\s+/));
    }
  }
  assert.ok(commands.length > 0, "README.md Install section documents an npm command");
  return commands;
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function installCopiedExtension(registryUrl, npmArgs) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-tutorial-install-"));
  const extensionCopy = path.join(workDir, "edit-tutorial");
  fs.cpSync(EXTENSION_DIR, extensionCopy, {
    recursive: true,
    filter: (src) => path.basename(src) !== "node_modules",
  });
  const userConfig = path.join(workDir, "npmrc");
  fs.writeFileSync(userConfig, "");
  const marker = path.join(workDir, "attacker-ran.txt");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_config_")) delete env[key];
  }
  Object.assign(env, {
    EDIT_TUTORIAL_MARKER: marker,
    npm_config_registry: registryUrl,
    npm_config_userconfig: userConfig,
    npm_config_cache: path.join(workDir, "cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0",
  });

  const [command, ...args] = npmArgs;
  const result = await run(command, args, { cwd: extensionCopy, env });
  const installedManifest = path.join(
    extensionCopy,
    "node_modules",
    "@github",
    "copilot-sdk",
    "package.json"
  );
  const installedSdkVersion = fs.existsSync(installedManifest)
    ? JSON.parse(fs.readFileSync(installedManifest, "utf8")).version
    : null;
  const attackerRan = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  fs.rmSync(workDir, { recursive: true, force: true });
  return { ...result, installedSdkVersion, attackerRan };
}

const installs = [
  ...documentedInstallCommands().map((args) => ({ label: `documented: ${args.join(" ")}`, args })),
  { label: "plain npm install in the copied folder", args: ["npm", "install"] },
];

for (const { label, args } of installs) {
  test(`edit-tutorial install does not run a package the registry swaps in (${label})`, async () => {
    const registry = await startAttackerRegistry();
    try {
      const result = await installCopiedExtension(registry.url, args);
      assert.equal(
        result.attackerRan,
        "",
        `install scripts from attacker-served packages ran:\n${result.attackerRan}\n${result.output}`
      );
      assert.notEqual(
        result.installedSdkVersion,
        ATTACKER_VERSION,
        "install resolved @github/copilot-sdk to the registry's current latest tag"
      );
    } finally {
      registry.server.close();
    }
  });
}

test("edit-tutorial pins @github/copilot-sdk exactly and locks it with an integrity hash", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "package.json"), "utf8"));
  const spec = manifest.dependencies["@github/copilot-sdk"];
  assert.match(spec, /^\d+\.\d+\.\d+$/, `@github/copilot-sdk must be an exact version, got "${spec}"`);

  const lockPath = path.join(EXTENSION_DIR, "package-lock.json");
  assert.ok(fs.existsSync(lockPath), "extensions/edit-tutorial/package-lock.json is committed");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(lock.packages[""].dependencies["@github/copilot-sdk"], spec);
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === "" || entry.link) continue;
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${location} resolved URL`);
    assert.match(entry.integrity ?? "", /^sha512-/, `${location} integrity`);
  }
  assert.equal(lock.packages["node_modules/@github/copilot-sdk"].version, spec);
});
