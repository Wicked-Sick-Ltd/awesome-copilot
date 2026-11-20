import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["skills/azure-devops-cli/SKILL.md", "skills/azure-container-registry-cli/SKILL.md"];

// Microsoft (Release signing) <gpgsecurity@microsoft.com>, the key that signs packages.microsoft.com.
const MICROSOFT_KEY_FPR = "BC528686B50D79E339D3721CEB3E94ADBE1229CF";
const GENUINE_KEY = path.join(ROOT, "eng/fixtures/microsoft-release-signing.asc");
const DIST = "noble";

const STUBS = {
  // Serves the configured body for the signing key URL and the attacker payload for anything else.
  curl: `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$SANDBOX/curl.log"
body="$PAYLOAD_FILE"
[ "$url" = "https://packages.microsoft.com/keys/microsoft.asc" ] && body="$KEY_FILE"
if [ -n "$out" ]; then cat "$body" > "$out"; else cat "$body"; fi
`,
  // Acts as root inside the sandbox: /etc paths are redirected, package managers are only recorded.
  sudo: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SANDBOX/sudo.log"
args=()
for a in "$@"; do
  case "$a" in /etc/*) args+=("$SANDBOX/root$a") ;; *) args+=("$a") ;; esac
done
case "$1" in
  install|tee|mkdir|chmod|cp|bash|sh|dash|zsh) exec "\${args[@]}" ;;
  *) exit 0 ;;
esac
`,
  "apt-get": `#!/usr/bin/env bash
printf 'unprivileged apt-get %s\\n' "$*" >> "$SANDBOX/sudo.log"
`,
  lsb_release: `#!/usr/bin/env bash
case "\${1:-}" in
  -is) printf '%s\\n' "\${DIST_ID:-Ubuntu}" ;;
  *) printf '%s\\n' "\${DIST_CODE:-noble}" ;;
esac
`,
  dpkg: `#!/usr/bin/env bash
echo amd64
`,
  brew: "#!/usr/bin/env bash\nexit 0\n",
  winget: "#!/usr/bin/env bash\nexit 0\n",
  az: `#!/usr/bin/env bash
if [ -n "\${AZ_STUB_VERSION:-}" ]; then
  printf '%s\\n' "\$AZ_STUB_VERSION"
fi
exit 0
`,
};

function prerequisitesScript(skillPath) {
  const text = fs.readFileSync(path.join(ROOT, skillPath), "utf8");
  const section = text.split(/^## Prerequisites\s*$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, `${skillPath} has a Prerequisites section`);
  const blocks = [...section.matchAll(/^```(?:bash|sh)\s*\n([\s\S]*?)^```/gm)].map((m) => m[1]);
  assert.ok(blocks.length > 0, `${skillPath} Prerequisites has a bash block`);
  return blocks.join("\n");
}

function fingerprints(keyFile) {
  const out = execFileSync("gpg", ["--batch", "--quiet", "--show-keys", "--with-colons", keyFile], {
    encoding: "utf8",
    env: { ...process.env, GNUPGHOME: fs.mkdtempSync(path.join(work, "fpr-")) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out
    .split("\n")
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]);
}

let work;
let attackerKey;
let genuinePlusAttackerKey;

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "azure-cli-install-"));
  const home = path.join(work, "attacker-gnupg");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: home };
  execFileSync(
    "gpg",
    ["--batch", "--passphrase", "", "--quick-gen-key", "Attacker <attacker@example.invalid>", "ed25519", "sign", "never"],
    { env, stdio: "ignore" },
  );
  attackerKey = path.join(work, "attacker.asc");
  fs.writeFileSync(attackerKey, execFileSync("gpg", ["--batch", "--armor", "--export"], { env }));
  spawnSync("gpgconf", ["--kill", "all"], { env });
  genuinePlusAttackerKey = path.join(work, "genuine-plus-attacker.asc");
  fs.writeFileSync(
    genuinePlusAttackerKey,
    Buffer.concat([fs.readFileSync(GENUINE_KEY), fs.readFileSync(attackerKey)]),
  );
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function runPrerequisites(skillPath, keyFile, options = {}) {
  const sandbox = fs.mkdtempSync(path.join(work, "run-"));
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(sandbox, "root/etc/apt/sources.list.d"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, "tmp"));
  const marker = path.join(sandbox, "payload-ran-as-root");
  const payload = path.join(sandbox, "payload.sh");
  fs.writeFileSync(payload, `touch "${marker}"\n`);

  const result = spawnSync("bash", ["-c", prerequisitesScript(skillPath)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SANDBOX: sandbox,
      TMPDIR: path.join(sandbox, "tmp"),
      KEY_FILE: keyFile,
      PAYLOAD_FILE: payload,
      DIST_ID: options.distId || "Ubuntu",
      DIST_CODE: options.distCode || DIST,
      AZ_STUB_VERSION: options.azVersion || "",
      AZ_OS_RELEASE: options.osRelease || "/etc/os-release",
    },
  });
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  return {
    result,
    payloadRan: fs.existsSync(marker),
    sudoCalls: read(path.join(sandbox, "sudo.log")).split("\n").filter(Boolean),
    keyring: path.join(sandbox, "root/etc/apt/keyrings/microsoft.gpg"),
    sources: read(path.join(sandbox, "root/etc/apt/sources.list.d/azure-cli.sources")),
    leftoverTmp: fs.readdirSync(path.join(sandbox, "tmp")),
  };
}

for (const skillPath of SKILLS) {
  describe(skillPath, () => {
    test("downloaded content is never executed as root", () => {
      const run = runPrerequisites(skillPath, attackerKey);
      assert.equal(run.payloadRan, false, `downloaded payload ran via: ${run.sudoCalls.join(" | ")}`);
      const shells = run.sudoCalls.filter((call) => /^(bash|sh|dash|zsh)\b/.test(call));
      assert.deepEqual(shells, [], "sudo is handed a shell interpreter");
    });

    test("an unpinned signing key aborts before anything is installed", () => {
      const run = runPrerequisites(skillPath, attackerKey);
      assert.equal(fs.existsSync(run.keyring), false, "attacker key was installed as an apt keyring");
      assert.equal(run.sources, "", "apt source was added without the pinned key");
      const apt = run.sudoCalls.filter((call) => call.includes("apt-get"));
      assert.ok(apt.some((call) => /lsb-release/.test(call) && /gnupg/.test(call)), "prerequisites were not installed");
      assert.deepEqual(
        apt.filter((call) => /azure-cli/.test(call)),
        [],
        "azure-cli apt ran without the pinned key",
      );
      assert.deepEqual(run.leftoverTmp, [], "temporary gpg home was not cleaned up");
    });

    test("a script served in place of the signing key is neither run nor installed", () => {
      const script = path.join(work, "script-as-key.sh");
      fs.writeFileSync(script, `#!/bin/sh\ntouch "$SANDBOX/payload-ran-as-root"\n`);
      const run = runPrerequisites(skillPath, script);
      assert.equal(run.payloadRan, false);
      assert.equal(fs.existsSync(run.keyring), false);
      assert.deepEqual(
        run.sudoCalls.filter((call) => /azure-cli/.test(call)),
        [],
      );
    });

    test("installs a version-pinned azure-cli trusted only by the pinned Microsoft key", () => {
      const run = runPrerequisites(skillPath, genuinePlusAttackerKey);
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(run.payloadRan, false);
      assert.ok(fs.existsSync(run.keyring), `no apt keyring written; stderr: ${run.result.stderr}`);
      assert.deepEqual(fingerprints(run.keyring), [MICROSOFT_KEY_FPR]);
      assert.match(run.sources, /^URIs: https:\/\/packages\.microsoft\.com\/repos\/azure-cli\/$/m);
      assert.match(run.sources, /^Signed-by: \/etc\/apt\/keyrings\/microsoft\.gpg$/m);

      const installs = run.sudoCalls.filter((call) => /^apt-get\b.*\binstall\b/.test(call));
      assert.ok(
        installs.some((call) => /\bcurl\b/.test(call) && /gnupg/.test(call) && /lsb-release/.test(call)),
        `prerequisites were not installed:\n${run.sudoCalls.join("\n")}`,
      );
      const cliInstalls = installs.filter((call) => /azure-cli=/.test(call));
      assert.equal(cliInstalls.length, 1, run.sudoCalls.join("\n"));
      const pinned = cliInstalls[0].match(/\bazure-cli=(\d+\.\d+\.\d+)-1~(\S+)/);
      assert.ok(pinned, `azure-cli is not version-pinned: ${cliInstalls[0]}`);
      assert.equal(pinned[2], DIST);
      assert.match(run.sources, new RegExp(`^Suites: ${DIST}$`, "m"));

      const stated = fs
        .readFileSync(path.join(ROOT, skillPath), "utf8")
        .match(/^\*\*CLI Version:\*\*\s*(\d+\.\d+\.\d+)/m);
      if (stated) assert.equal(pinned[1], stated[1], "pinned version differs from the skill's CLI Version");
      assert.deepEqual(run.leftoverTmp, [], "temporary gpg home was not cleaned up");
    });

    test("unknown Ubuntu and Debian suites fall back to a suite that published the pin", () => {
      const ubuntu = runPrerequisites(skillPath, genuinePlusAttackerKey, { distId: "Ubuntu", distCode: "resolute" });
      assert.equal(ubuntu.result.status, 0, ubuntu.result.stderr);
      assert.match(ubuntu.sources, /^Suites: jammy$/m);
      assert.ok(ubuntu.sudoCalls.some((call) => call.includes("azure-cli=2.81.0-1~jammy")));

      const debian = runPrerequisites(skillPath, genuinePlusAttackerKey, { distId: "Debian", distCode: "trixie" });
      assert.equal(debian.result.status, 0, debian.result.stderr);
      assert.match(debian.sources, /^Suites: bookworm$/m);
      assert.ok(debian.sudoCalls.some((call) => call.includes("azure-cli=2.81.0-1~bookworm")));
    });

    test("Linux Mint uses its Ubuntu base codename when that suite published the pin", () => {
      const osRelease = path.join(work, `os-release-${skillPath.replaceAll("/", "-")}`);
      fs.writeFileSync(osRelease, "ID=linuxmint\nUBUNTU_CODENAME=noble\n");
      const run = runPrerequisites(skillPath, genuinePlusAttackerKey, {
        distId: "LinuxMint",
        distCode: "xia",
        osRelease,
      });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.match(run.sources, /^Suites: noble$/m);
      assert.ok(run.sudoCalls.some((call) => call.includes("azure-cli=2.81.0-1~noble")));
    });

    test("an already-newer azure-cli is kept instead of downgraded", () => {
      const newer = runPrerequisites(skillPath, genuinePlusAttackerKey, { azVersion: "2.90.0" });
      assert.equal(newer.result.status, 0, newer.result.stderr);
      assert.deepEqual(newer.sudoCalls.filter((call) => /azure-cli/.test(call)), []);
      assert.equal(newer.sources, "");

      const older = runPrerequisites(skillPath, genuinePlusAttackerKey, { azVersion: "2.70.0" });
      assert.equal(older.result.status, 0, older.result.stderr);
      assert.ok(older.sudoCalls.some((call) => call.includes(`azure-cli=2.81.0-1~${DIST}`)));
    });
  });
}
