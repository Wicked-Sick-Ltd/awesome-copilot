#!/usr/bin/env python3
"""Author and email values must not become TOML syntax in scaffolded packages.

scaffold.py interpolates --author and --email into double-quoted strings in
pyproject.toml. These tests fail while that interpolation is unescaped: a
value can close the authors table and add a direct-reference dependency, and
the documented ``pip install -e '.[dev]'`` step then builds that dependency.

They pass when the script either refuses the value before it creates any file,
or writes parseable TOML whose authors round-trip and whose dependency lists
do not gain a direct reference.

The setuptools template also has a pre-existing extra ``]`` that makes its
pyproject.toml invalid. A successful (exit 0) run is still required to parse,
so an encoding fix has to emit valid TOML. Refusing the unsafe value before
writing files passes without that change.

Not covered: gen_license() writes the author into the LICENSE copyright line
only. That string is not a dependency and is not an install-time code path.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "skills" / "python-pypi-package-builder" / "scripts" / "scaffold.py"
PACKAGE_NAME = "samplepkg"
DIRECT_URL_NAME = "fixturedep"


def _breakout(field: str, url: str) -> str:
    """Close the authors table, add a direct URL dependency, keep the file valid.

    The hash comment swallows the rest of the original author line. The dummy
    array consumes the template's closing bracket. A separate table holds the
    template's later ``dependencies`` key so it is not a duplicate. The hatch
    flag is required by hatchling before it will emit a direct reference.
    """

    injected = (
        "]\n"
        f'dependencies = ["{DIRECT_URL_NAME} @ {url}"]\n'
        "\n"
        "[tool.hatch.metadata]\n"
        "allow-direct-references = true\n"
        "\n"
        "[ignored]\n"
        "dummy = [\n"
        "#"
    )
    if field == "author":
        return 'Closed", email = "injected@example.com"}\n' + injected
    if field == "email":
        return 'injected@example.com"}\n' + injected
    raise AssertionError(field)


def _requirement_strings(data: dict) -> list[str]:
    project = data.get("project", {})
    found = [str(item) for item in project.get("dependencies") or []]
    optional = project.get("optional-dependencies") or {}
    for group in optional.values():
        found.extend(str(item) for item in group)
    build = data.get("build-system") or {}
    found.extend(str(item) for item in build.get("requires") or [])
    return found


def _is_direct_reference(requirement: str) -> bool:
    return "://" in requirement or " @ " in requirement


class ScaffoldAuthorEmailTests(unittest.TestCase):
    def _run(self, output: Path, **options: str) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(SCRIPT),
            "--name",
            PACKAGE_NAME,
            "--output",
            str(output),
        ]
        for flag in ("build", "layout", "author", "email"):
            if flag in options:
                command.extend([f"--{flag}", options[flag]])
        return subprocess.run(command, capture_output=True, text=True, check=False)

    def _assert_refused_without_files(self, output: Path, completed: subprocess.CompletedProcess[str]) -> None:
        self.assertNotEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse((output / PACKAGE_NAME).exists(), "package tree exists after a refusal")
        self.assertEqual(list(output.rglob("*")), [], "scaffold created files before refusing")

    def _assert_safe_or_refused(self, output: Path, author: str, email: str, build: str) -> None:
        completed = self._run(output, build=build, author=author, email=email)
        if completed.returncode != 0:
            self._assert_refused_without_files(output, completed)
            return
        pyproject = output / PACKAGE_NAME / "pyproject.toml"
        self.assertTrue(pyproject.is_file(), completed.stdout + completed.stderr)
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        self.assertEqual(data["project"]["authors"], [{"name": author, "email": email}])
        for requirement in _requirement_strings(data):
            self.assertFalse(
                _is_direct_reference(requirement),
                f"{build} dependency list gained a direct reference: {requirement}",
            )
        backend = data["build-system"]["build-backend"]
        if build == "hatchling":
            self.assertEqual(backend, "hatchling.build")
        else:
            self.assertEqual(backend, "setuptools.build_meta")

    def test_plain_author_and_email_round_trip_for_hatchling(self) -> None:
        author = "Ada Lovelace"
        email = "ada@example.com"
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            completed = self._run(output, build="hatchling", author=author, email=email)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            data = tomllib.loads((output / PACKAGE_NAME / "pyproject.toml").read_text(encoding="utf-8"))
            self.assertEqual(data["project"]["authors"], [{"name": author, "email": email}])
            self.assertEqual(data["project"]["dependencies"], [])
            self.assertIn("pip install -e '.[dev]'", completed.stdout)

    def test_plain_author_and_email_are_accepted_for_setuptools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            completed = self._run(
                output,
                build="setuptools",
                author="Ada Lovelace",
                email="ada@example.com",
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue((output / PACKAGE_NAME / "pyproject.toml").is_file())

    def test_breakout_characters_do_not_change_dependency_metadata(self) -> None:
        samples = (
            'Ada "A" Lovelace',
            "Ada\nLovelace",
            "Ada\\Lovelace",
            "Ada [Lovelace]",
        )
        for build in ("hatchling", "setuptools"):
            for layout in ("flat", "src"):
                for author in samples:
                    with self.subTest(build=build, layout=layout, field="author", value=author):
                        with tempfile.TemporaryDirectory() as tmp:
                            output = Path(tmp)
                            completed = self._run(
                                output,
                                build=build,
                                layout=layout,
                                author=author,
                                email="ada@example.com",
                            )
                            if completed.returncode != 0:
                                self._assert_refused_without_files(output, completed)
                                continue
                            data = tomllib.loads(
                                (output / PACKAGE_NAME / "pyproject.toml").read_text(encoding="utf-8")
                            )
                            self.assertEqual(
                                data["project"]["authors"],
                                [{"name": author, "email": "ada@example.com"}],
                            )
                            for requirement in _requirement_strings(data):
                                self.assertFalse(_is_direct_reference(requirement))
                for email in samples:
                    with self.subTest(build=build, layout=layout, field="email", value=email):
                        with tempfile.TemporaryDirectory() as tmp:
                            output = Path(tmp)
                            completed = self._run(
                                output,
                                build=build,
                                layout=layout,
                                author="Ada Lovelace",
                                email=email,
                            )
                            if completed.returncode != 0:
                                self._assert_refused_without_files(output, completed)
                                continue
                            data = tomllib.loads(
                                (output / PACKAGE_NAME / "pyproject.toml").read_text(encoding="utf-8")
                            )
                            self.assertEqual(
                                data["project"]["authors"],
                                [{"name": "Ada Lovelace", "email": email}],
                            )
                            for requirement in _requirement_strings(data):
                                self.assertFalse(_is_direct_reference(requirement))

    def test_author_and_email_breakout_cannot_add_a_direct_dependency(self) -> None:
        url = "file:///tmp/fixturedep-1.0.0.tar.gz"
        for build in ("hatchling", "setuptools"):
            for field in ("author", "email"):
                with self.subTest(build=build, field=field):
                    payload = _breakout(field, url)
                    author = payload if field == "author" else "Ada Lovelace"
                    email = payload if field == "email" else "ada@example.com"
                    with tempfile.TemporaryDirectory() as tmp:
                        self._assert_safe_or_refused(Path(tmp), author, email, build)

    def test_documented_editable_install_does_not_run_injected_dependency_code(self) -> None:
        for field in ("author", "email"):
            with self.subTest(field=field):
                self._assert_install_does_not_execute_breakout(field)

    def _assert_install_does_not_execute_breakout(self, field: str) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / "dependency-installer-ran"
            sdist = self._write_sdist(root / "dist", marker)
            url = sdist.as_uri()
            payload = _breakout(field, url)
            author = payload if field == "author" else "Ada Lovelace"
            email = payload if field == "email" else "ada@example.com"
            output = root / "scaffold"
            output.mkdir()
            completed = self._run(output, build="hatchling", author=author, email=email)
            if completed.returncode != 0:
                self._assert_refused_without_files(output, completed)
                self.assertFalse(marker.exists())
                return

            package_root = output / PACKAGE_NAME
            self.assertIn("pip install -e '.[dev]'", completed.stdout)
            install = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--target",
                    str(root / "installed"),
                    "-e",
                    ".[dev]",
                ],
                cwd=package_root,
                capture_output=True,
                text=True,
                check=False,
                timeout=180,
                env={**os.environ, "PIP_NO_INPUT": "1"},
            )
            self.assertFalse(
                marker.exists(),
                "pip install -e '.[dev]' executed the injected dependency's installer\n"
                + install.stdout[-2000:]
                + install.stderr[-2000:],
            )
            data = tomllib.loads((package_root / "pyproject.toml").read_text(encoding="utf-8"))
            self.assertEqual(data["project"]["authors"], [{"name": author, "email": email}])
            for requirement in _requirement_strings(data):
                self.assertFalse(_is_direct_reference(requirement), requirement)

    def _write_sdist(self, dist_dir: Path, marker: Path) -> Path:
        dist_dir.mkdir(parents=True)
        source = dist_dir / f"{DIRECT_URL_NAME}-1.0.0"
        package_dir = source / DIRECT_URL_NAME
        package_dir.mkdir(parents=True)
        (package_dir / "__init__.py").write_text('value = "fixture"\n', encoding="utf-8")
        setup_py = textwrap.dedent(
            f"""\
            from pathlib import Path
            from setuptools import setup

            Path({str(marker)!r}).write_text("executed", encoding="utf-8")
            setup(name={DIRECT_URL_NAME!r}, version="1.0.0", packages=[{DIRECT_URL_NAME!r}])
            """
        )
        (source / "setup.py").write_text(setup_py, encoding="utf-8")
        archive_path = dist_dir / f"{DIRECT_URL_NAME}-1.0.0.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(source, arcname=source.name)
        return archive_path


if __name__ == "__main__":
    unittest.main()
