"""Regression: the nano-banana image script must install only locked, hashed dependencies.

The skill runs generate_image.py with `uv run` while OPENROUTER_API_KEY is set.
A newer release of any package in its dependency tree, or a different file
published under a pinned version, must not be installed and imported.
"""

import base64
import hashlib
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import tempfile
import tomllib
import unittest
import zipfile

ROOT = pathlib.Path(__file__).parents[1]
SKILL_DIR = ROOT / "skills" / "nano-banana-pro-openrouter"
SKILL_MD = SKILL_DIR / "SKILL.md"
SCRIPT = SKILL_DIR / "scripts" / "generate_image.py"
LOCKFILE = SCRIPT.with_name(SCRIPT.name + ".lock")

PLACEHOLDER_KEY = "placeholder-not-a-real-key"
FAKE_RELEASE = "9999.0.0"
# Packages imported while the script loads that a malicious release could replace.
# sniffio and idna are transitive dependencies of openai without upper bounds.
SUBSTITUTED_PACKAGES = ("openai", "sniffio", "idna")


def script_metadata():
    text = SCRIPT.read_text(encoding="utf-8")
    match = re.search(r"^# /// script\n((?:#.*\n)*?)^# ///$", text, flags=re.MULTILINE)
    if not match:
        raise AssertionError(f"{SCRIPT} has no inline script metadata")
    body = "".join(line[2:] if line.startswith("# ") else line[1:] for line in match.group(1).splitlines(True))
    return tomllib.loads(body)


def documented_commands():
    """Return each `uv run` invocation in SKILL.md, up to and including the script path."""
    text = SKILL_MD.read_text(encoding="utf-8").replace("\\\n", " ")
    commands = []
    for line in text.splitlines():
        if not line.strip().startswith("uv run"):
            continue
        tokens = shlex.split(line.replace("{baseDir}", str(SKILL_DIR)))
        end = next(i for i, token in enumerate(tokens) if token.endswith("generate_image.py"))
        commands.append(tokens[: end + 1])
    return commands


def build_fake_wheel(directory, name, version):
    """Write a wheel whose import records whether OPENROUTER_API_KEY was visible."""
    module = (
        "import os, pathlib\n"
        "_marker = os.environ.get('FAKE_PACKAGE_MARKER')\n"
        "if _marker:\n"
        f"    pathlib.Path(_marker).write_text('{name}=={version} imported; key visible: '"
        " + str('OPENROUTER_API_KEY' in os.environ))\n"
    ).encode()
    dist_info = f"{name}-{version}.dist-info"
    files = {
        f"{name}/__init__.py": module,
        f"{dist_info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n".encode(),
        f"{dist_info}/WHEEL": b"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }

    def record_hash(data):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        return f"sha256={digest}"

    record = "".join(f"{path},{record_hash(data)},{len(data)}\n" for path, data in files.items())
    files[f"{dist_info}/RECORD"] = (record + f"{dist_info}/RECORD,,\n").encode()
    with zipfile.ZipFile(directory / f"{name}-{version}-py3-none-any.whl", "w") as wheel:
        for path, data in files.items():
            wheel.writestr(path, data)


class LockfileTests(unittest.TestCase):
    def test_direct_dependencies_are_exact_pins(self):
        for requirement in script_metadata()["dependencies"]:
            self.assertRegex(requirement, r"^[A-Za-z0-9._-]+==[^,;]+$")

    def test_lockfile_matches_script_and_hashes_every_artifact(self):
        self.assertTrue(LOCKFILE.is_file(), f"missing {LOCKFILE.relative_to(ROOT)}; run `uv lock --script`")
        lock = tomllib.loads(LOCKFILE.read_text(encoding="utf-8"))

        locked = {
            f"{entry['name']}{entry.get('specifier', '')}" for entry in lock["manifest"]["requirements"]
        }
        self.assertEqual(locked, set(script_metadata()["dependencies"]))

        packages = lock["package"]
        self.assertTrue(packages)
        for package in packages:
            self.assertIn("registry", package["source"], package["name"])
            artifacts = list(package.get("wheels", []))
            if "sdist" in package:
                artifacts.append(package["sdist"])
            self.assertTrue(artifacts, package["name"])
            for artifact in artifacts:
                self.assertRegex(artifact.get("hash", ""), r"^sha256:[0-9a-f]{64}$", artifact.get("url"))

    def test_documented_commands_refuse_a_stale_lockfile(self):
        commands = documented_commands()
        self.assertTrue(commands)
        for command in commands:
            self.assertIn("--locked", command)


@unittest.skipUnless(shutil.which("uv"), "uv is not installed")
class DocumentedRunTests(unittest.TestCase):
    """Run the skill's own command with a malicious package available to uv."""

    def run_with_substitute(self, name, version):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            links = tmp / "links"
            links.mkdir()
            build_fake_wheel(links, name, version)
            marker = tmp / "marker"

            env = {k: v for k, v in os.environ.items() if not k.startswith(("UV_", "PIP_", "OPENROUTER_"))}
            env.update(
                UV_NO_CONFIG="1",
                UV_CACHE_DIR=str(tmp / "cache"),
                UV_FIND_LINKS=str(links),
                FAKE_PACKAGE_MARKER=str(marker),
                OPENROUTER_API_KEY=PLACEHOLDER_KEY,
            )
            command = documented_commands()[0] + ["--help"]
            result = subprocess.run(command, cwd=tmp, env=env, capture_output=True, text=True, timeout=600)

            self.assertFalse(
                marker.exists(),
                marker.read_text() if marker.exists() else "",
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("usage: generate_image.py", result.stdout)

    def test_newer_releases_are_not_installed(self):
        for name in SUBSTITUTED_PACKAGES:
            with self.subTest(package=name):
                self.run_with_substitute(name, FAKE_RELEASE)

    def test_other_file_for_pinned_version_is_not_installed(self):
        pins = [r.split("==", 1) for r in script_metadata()["dependencies"] if "==" in r]
        self.assertTrue(pins, "no dependency is pinned to an exact version")
        for name, version in pins:
            with self.subTest(package=name):
                self.run_with_substitute(name, version)


if __name__ == "__main__":
    unittest.main()
