"""Regression: speak-summary must only install pocket-tts from its hash-pinned lockfile."""

import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = pathlib.Path(__file__).parents[1]
SCRIPT = ROOT / "skills" / "speak-summary" / "scripts" / "tts.sh"
LOCK = ROOT / "skills" / "speak-summary" / "scripts" / "requirements.txt"

# pip options that consume the following argument.
PIP_OPTS_WITH_VALUE = {"-r", "--requirement", "-c", "--constraint", "--only-binary", "--no-binary"}

PIP_HANDLER = textwrap.dedent(
    """
    import json, os, sys

    def pip(args):
        here = os.path.dirname(os.path.abspath(sys.argv[0]))
        with open(os.environ["FAKE_LOG"], "a") as log:
            log.write(json.dumps({"tool": "pip", "venv": os.path.dirname(here), "args": args}) + "\\n")
        if args[:1] == ["install"]:
            tts = os.path.join(here, "pocket-tts")
            with open(tts, "w") as f:
                f.write(open(os.environ["FAKE_TTS_SRC"]).read())
            os.chmod(tts, 0o755)
    """
)

FAKE_VENV_PYTHON = "#!/usr/bin/env python3\n" + PIP_HANDLER + textwrap.dedent(
    """
    argv = sys.argv[1:]
    if argv[:2] == ["-m", "pip"]:
        pip(argv[2:])
    else:
        sys.exit("unexpected venv python call: %r" % argv)
    """
)

FAKE_VENV_PIP = "#!/usr/bin/env python3\n" + PIP_HANDLER + "pip(sys.argv[1:])\n"

FAKE_SYSTEM_PYTHON = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, shutil, sys

    argv = sys.argv[1:]
    if argv[:1] == ["-c"]:
        sys.exit(0)
    if argv[:2] == ["-m", "venv"]:
        target = argv[-1]
        if "--clear" in argv and os.path.isdir(target):
            shutil.rmtree(target)
        os.makedirs(os.path.join(target, "bin"), exist_ok=True)
        open(os.path.join(target, "pyvenv.cfg"), "w").close()
        for name, src in (("python", "FAKE_VENV_PYTHON_SRC"), ("pip", "FAKE_VENV_PIP_SRC")):
            dest = os.path.join(target, "bin", name)
            shutil.copy(os.environ[src], dest)
            os.chmod(dest, 0o755)
        with open(os.environ["FAKE_LOG"], "a") as log:
            log.write(json.dumps({"tool": "venv", "args": argv}) + "\\n")
        sys.exit(0)
    sys.exit("unexpected system python call: %r" % argv)
    """
)

FAKE_TTS = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import sys
    args = sys.argv[1:]
    open(args[args.index("--output-path") + 1], "wb").write(b"RIFF")
    """
)

FAKE_FFMPEG = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import sys
    open(sys.argv[-1], "wb").write(b"ID3")
    """
)


def lock_requirements(text):
    """Return each requirement in a pip requirements file with continuations joined."""
    joined = re.sub(r"\\\n", " ", text)
    reqs = []
    for line in joined.splitlines():
        line = line.split(" #", 1)[0].strip()
        if not line or line.startswith("#"):
            continue
        reqs.append(line)
    return reqs


def positional_args(args):
    out, skip = [], False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg in PIP_OPTS_WITH_VALUE:
            skip = True
            continue
        if not arg.startswith("-"):
            out.append(arg)
    return out


def option_value(args, *names):
    for i, arg in enumerate(args):
        if arg in names and i + 1 < len(args):
            return args[i + 1]
        for name in names:
            if name.startswith("--") and arg.startswith(name + "="):
                return arg.split("=", 1)[1]
    return None


class SpeakSummaryInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls.jsonl"
        fakes = self.tmp / "fakes"
        fakes.mkdir()
        sources = {
            "venv-python": FAKE_VENV_PYTHON,
            "venv-pip": FAKE_VENV_PIP,
            "pocket-tts": FAKE_TTS,
        }
        for name, body in sources.items():
            (fakes / name).write_text(body)
        for name, body in (("python3.14", FAKE_SYSTEM_PYTHON), ("ffmpeg", FAKE_FFMPEG)):
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)
        self.venv = self.home / ".cache" / "speak-summary" / "venv"
        self.env = {
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_LOG": str(self.log),
            "FAKE_VENV_PYTHON_SRC": str(fakes / "venv-python"),
            "FAKE_VENV_PIP_SRC": str(fakes / "venv-pip"),
            "FAKE_TTS_SRC": str(fakes / "pocket-tts"),
        }
        self.input = self.tmp / "in.txt"
        self.input.write_text("Good morning. This is a short briefing.\n")

    def run_tts(self):
        self.log.write_text("")
        result = subprocess.run(
            ["bash", str(SCRIPT), str(self.input), str(self.tmp / "out.mp3")],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def pip_installs(self, calls):
        return [c["args"] for c in calls if c["tool"] == "pip" and c["args"][:1] == ["install"]]

    def assert_installs_only_from_lock(self, installs):
        self.assertTrue(installs, "expected the script to install pocket-tts")
        for args in installs:
            self.assertIn("--require-hashes", args, f"pip install without hash checking: {args}")
            self.assertEqual(
                positional_args(args),
                ["install"],
                f"pip install named a package outside the lockfile: {args}",
            )
            requirement = option_value(args, "-r", "--requirement")
            self.assertIsNotNone(requirement, f"pip install without a requirements file: {args}")
            self.assertEqual(pathlib.Path(requirement).resolve(), LOCK.resolve())

    def test_first_run_installs_only_from_hash_pinned_lockfile(self):
        calls = self.run_tts()
        self.assert_installs_only_from_lock(self.pip_installs(calls))

    def test_lockfile_pins_every_requirement_to_a_version_and_hash(self):
        self.assertTrue(LOCK.is_file(), f"missing {LOCK.relative_to(ROOT)}")
        reqs = lock_requirements(LOCK.read_text(encoding="utf-8"))
        names = set()
        for req in reqs:
            self.assertFalse(req.startswith("-"), f"unexpected pip option in lockfile: {req}")
            spec = req.split("--hash", 1)[0].split(";", 1)[0].strip()
            self.assertRegex(spec, r"^[A-Za-z0-9._-]+==[A-Za-z0-9.!+_-]+$", f"not pinned with ==: {req}")
            self.assertRegex(req, r"--hash=sha256:[0-9a-f]{64}", f"no sha256 hash: {req}")
            names.add(re.split(r"==", spec)[0].lower().replace("_", "-"))
        self.assertIn("pocket-tts", names)

    def test_venv_from_an_earlier_unpinned_install_is_rebuilt_from_lock(self):
        (self.venv / "bin").mkdir(parents=True)
        (self.venv / "pyvenv.cfg").write_text("")
        stale = self.venv / "bin" / "pocket-tts"
        stale.write_text(FAKE_TTS)
        stale.chmod(0o755)

        calls = self.run_tts()

        venv_calls = [c["args"] for c in calls if c["tool"] == "venv"]
        self.assertEqual(len(venv_calls), 1, calls)
        self.assertIn("--clear", venv_calls[0])
        self.assert_installs_only_from_lock(self.pip_installs(calls))

    def test_venv_built_from_current_lock_is_reused(self):
        self.run_tts()
        calls = self.run_tts()
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
