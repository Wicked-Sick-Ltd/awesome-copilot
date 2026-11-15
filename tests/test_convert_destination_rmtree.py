"""Existing conversion destinations must not be deleted.

`convert_pdf_to_md.py` and `convert_word_to_md.py` pick an output directory
(the `-o` path in single-file mode, or a sibling/child directory named after
the document stem otherwise) and, when that path already exists, call
`shutil.rmtree` on it. These tests fail while that delete is reachable and
pass when a directory that is not solely a previous conversion output is left
unchanged, including across the gap between the existence check and the delete.

`convert_excel_to_md.py` is not covered. It does not remove the destination
directory; it only removes a child `img/` directory when the destination
already exists.
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
PDF_SCRIPT = REPO / "skills" / "convert-pdf-to-md" / "scripts" / "convert_pdf_to_md.py"
DOCX_SCRIPT = REPO / "skills" / "convert-word-to-md" / "scripts" / "convert_word_to_md.py"

KEEP_TEXT = "keep-me\n"
DEEP_TEXT = "deep-keep\n"
KEEP_BYTES = b"\x00\x01keep"
SWAPPED_TEXT = "swapped-after-exists\n"
SWAPPED_DEEP = "swapped-deep\n"


def write_pdf(path: Path, text: str) -> None:
    import pymupdf

    document = pymupdf.open()
    try:
        page = document.new_page()
        page.insert_text((72, 72), text)
        document.save(path)
    finally:
        document.close()


def write_docx(path: Path, text: str) -> None:
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body>
</w:document>
"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("word/document.xml", document)


CONVERTERS = (
    {"name": "pdf", "script": PDF_SCRIPT, "extension": ".pdf", "write": write_pdf},
    {"name": "docx", "script": DOCX_SCRIPT, "extension": ".docx", "write": write_docx},
)


def run_converter(script: Path, args, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *[str(arg) for arg in args]],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )


def plant_tree(root: Path, keep_text: str = KEEP_TEXT, deep_text: str = DEEP_TEXT) -> None:
    nested = root / "pkg" / "nested"
    nested.mkdir(parents=True)
    (root / "keep.txt").write_text(keep_text)
    (root / "keep.bin").write_bytes(KEEP_BYTES)
    (nested / "deep.txt").write_text(deep_text)


def snapshot(root: Path) -> dict:
    recorded = {}
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        rel_dir = current.relative_to(root).as_posix()
        recorded[("dir", rel_dir)] = sorted(dirnames)
        for name in filenames:
            path = current / name
            # Do not follow links: the bytes of a linked target are not this tree.
            if path.is_symlink():
                recorded[("link", path.relative_to(root).as_posix())] = os.readlink(path)
            else:
                recorded[("file", path.relative_to(root).as_posix())] = path.read_bytes()
    return recorded


def snapshot_diff(before: dict, after: dict) -> str:
    lines = []
    for key in sorted(set(before) | set(after), key=repr):
        if key not in after:
            lines.append(f"removed {key[0]} {key[1]}")
        elif key not in before:
            lines.append(f"added {key[0]} {key[1]}")
        elif before[key] != after[key]:
            lines.append(f"changed {key[0]} {key[1]}")
    return "\n".join(lines[:80])


def assert_unchanged(case: unittest.TestCase, root: Path, before: dict, proc, label: str) -> None:
    if not root.is_dir():
        listing = "missing"
        if root.exists():
            listing = f"replaced by a non-directory ({root})"
        case.fail(
            f"{label}: destination was removed\n"
            f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}\n"
            f"path={root} ({listing})"
        )
    after = snapshot(root)
    case.assertEqual(
        before,
        after,
        f"{label}: destination changed\n{snapshot_diff(before, after)}\n"
        f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}",
    )


def load_module(script: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def same_path(left, right) -> bool:
    return os.path.normcase(os.path.abspath(os.fspath(left))) == os.path.normcase(
        os.path.abspath(os.fspath(right))
    )


def setUpModule() -> None:
    for converter in CONVERTERS:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / f"plain{converter['extension']}"
            converter["write"](source, "control document")
            proc = run_converter(converter["script"], [source], root)
            markdown = root / source.stem / f"{source.stem}.md"
            if proc.returncode != 0 or not markdown.is_file():
                raise AssertionError(
                    f"{converter['name']} control conversion did not write {markdown}\n"
                    f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}"
                )


class DestinationRmtreeTests(unittest.TestCase):
    def test_single_file_does_not_delete_sibling_stem_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                self._assert_sibling_survives(converter, "src", f"src{converter['extension']}")

    def test_single_file_uppercase_suffix_does_not_delete_sibling_stem_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                suffix = converter["extension"].upper()
                self._assert_sibling_survives(converter, "src", f"src{suffix}")

    def test_single_file_does_not_delete_git_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                self._assert_sibling_survives(converter, ".git", f".git{converter['extension']}")

    def test_single_file_does_not_delete_documents_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                self._assert_sibling_survives(
                    converter, "Documents", f"Documents{converter['extension']}"
                )

    def test_single_file_output_flag_does_not_delete_existing_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    source = root / f"note{converter['extension']}"
                    victim = root / "project"
                    plant_tree(victim)
                    (victim / "src").mkdir()
                    (victim / "src" / "main.py").write_text("print('stay')\n")
                    before = snapshot(victim)
                    converter["write"](source, "output flag")
                    proc = run_converter(
                        converter["script"],
                        [source, "-o", victim],
                        root,
                    )
                    assert_unchanged(
                        self,
                        victim,
                        before,
                        proc,
                        f"{converter['name']} -o existing directory",
                    )

    def test_batch_does_not_delete_sibling_stem_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    victim = root / "src"
                    plant_tree(victim)
                    before = snapshot(victim)
                    (root / "unrelated.txt").write_text("leave-me\n")
                    converter["write"](root / f"src{converter['extension']}", "batch src")
                    converter["write"](root / f"notes{converter['extension']}", "batch notes")
                    proc = run_converter(converter["script"], [root], root)
                    assert_unchanged(
                        self,
                        victim,
                        before,
                        proc,
                        f"{converter['name']} batch default",
                    )
                    self.assertEqual((root / "unrelated.txt").read_text(), "leave-me\n")

    def test_batch_output_flag_does_not_delete_stem_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    incoming = root / "incoming"
                    incoming.mkdir()
                    output = root / "output"
                    victim = output / "src"
                    plant_tree(victim)
                    before = snapshot(victim)
                    (output / "sentinel.txt").write_text("sentinel\n")
                    converter["write"](incoming / f"src{converter['extension']}", "batch -o")
                    proc = run_converter(
                        converter["script"],
                        [incoming, "-o", output],
                        root,
                    )
                    assert_unchanged(
                        self,
                        victim,
                        before,
                        proc,
                        f"{converter['name']} batch -o",
                    )
                    self.assertEqual((output / "sentinel.txt").read_text(), "sentinel\n")

    def test_batch_recursive_does_not_delete_nested_stem_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    nested = root / "nested" / "deep"
                    victim = nested / "src"
                    plant_tree(victim)
                    before = snapshot(victim)
                    (nested / "beside.txt").write_text("beside\n")
                    converter["write"](nested / f"src{converter['extension']}", "recursive")
                    proc = run_converter(
                        converter["script"],
                        [root, "--recursive"],
                        root,
                    )
                    assert_unchanged(
                        self,
                        victim,
                        before,
                        proc,
                        f"{converter['name']} recursive batch",
                    )
                    self.assertEqual((nested / "beside.txt").read_text(), "beside\n")

    def test_batch_recursive_output_flag_does_not_delete_stem_directory(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    incoming = root / "incoming" / "nested"
                    incoming.mkdir(parents=True)
                    output = root / "output"
                    victim = output / "nested" / "src"
                    plant_tree(victim)
                    before = snapshot(victim)
                    (output / "sentinel.txt").write_text("sentinel\n")
                    converter["write"](
                        incoming / f"src{converter['extension']}",
                        "recursive -o",
                    )
                    proc = run_converter(
                        converter["script"],
                        [root / "incoming", "-o", output, "--recursive"],
                        root,
                    )
                    assert_unchanged(
                        self,
                        victim,
                        before,
                        proc,
                        f"{converter['name']} recursive batch -o",
                    )
                    self.assertEqual((output / "sentinel.txt").read_text(), "sentinel\n")

    def test_prior_output_shape_with_extra_file_is_not_deleted(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    victim = root / "report"
                    (victim / "img").mkdir(parents=True)
                    (victim / "report.md").write_text("previous markdown\n")
                    (victim / "img" / "page001_img001.png").write_bytes(b"png-bytes")
                    (victim / "secrets.txt").write_text("do-not-delete\n")
                    (victim / "img" / "notes.txt").write_text("extra image note\n")
                    before = snapshot(victim)
                    converter["write"](root / f"report{converter['extension']}", "report")
                    proc = run_converter(
                        converter["script"],
                        [root / f"report{converter['extension']}"],
                        root,
                    )
                    assert_unchanged(
                        self,
                        victim,
                        before,
                        proc,
                        f"{converter['name']} prior-output-shaped directory",
                    )

    def test_directory_replaced_after_exists_check_is_not_deleted(self):
        for converter in CONVERTERS:
            with self.subTest(converter=converter["name"]):
                self._assert_swap_after_exists_survives(converter)

    def _assert_sibling_survives(self, converter, directory_name: str, filename: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            victim = root / directory_name
            plant_tree(victim)
            before = snapshot(victim)
            source = root / filename
            converter["write"](source, f"sibling {directory_name}")
            proc = run_converter(converter["script"], [source], root)
            assert_unchanged(
                self,
                victim,
                before,
                proc,
                f"{converter['name']} sibling {directory_name}",
            )

    def _assert_swap_after_exists_survives(self, converter) -> None:
        """Swap the destination inode after Path.exists() reports it.

        A fix that checks the path and then looks that same path up again to
        delete it still removes the replacement tree. Deleting through the
        directory that was opened for the check does not.
        """
        module = load_module(converter["script"], f"race_{converter['name']}_dest")
        self.assertIs(module.shutil.rmtree, shutil.rmtree)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dest = root / "src"
            plant_tree(dest)
            staged = root / "src-staged"
            plant_tree(staged, keep_text=SWAPPED_TEXT, deep_text=SWAPPED_DEEP)
            (staged / "swapped-keep.txt").write_text(SWAPPED_TEXT)
            parked = root / "src-observed"
            source = root / f"src{converter['extension']}"
            converter["write"](source, "race")
            state = {"fired": False}
            original_exists = Path.exists

            def exists(path, *, follow_symlinks=True):
                found = original_exists(path, follow_symlinks=follow_symlinks)
                if found and not state["fired"] and same_path(path, dest):
                    state["fired"] = True
                    os.rename(dest, parked)
                    os.rename(staged, dest)
                return found

            argv = sys.argv
            try:
                Path.exists = exists
                sys.argv = [str(converter["script"]), str(source)]
                module.main()
            finally:
                Path.exists = original_exists
                sys.argv = argv

            if state["fired"]:
                self.assertTrue(
                    (parked / "keep.txt").is_file(),
                    "original tree disappeared during the existence check",
                )
                self.assertEqual((parked / "keep.txt").read_text(), KEEP_TEXT)
                swapped = dest / "swapped-keep.txt"
                self.assertTrue(
                    swapped.is_file() and swapped.read_text() == SWAPPED_TEXT,
                    "directory looked up again after exists() was deleted: "
                    f"dest={_describe(dest)}",
                )
                self.assertEqual((dest / "pkg" / "nested" / "deep.txt").read_text(), SWAPPED_DEEP)
            else:
                self.assertEqual((dest / "keep.txt").read_text(), KEEP_TEXT)
                self.assertEqual((dest / "pkg" / "nested" / "deep.txt").read_text(), DEEP_TEXT)
                self.assertEqual((dest / "keep.bin").read_bytes(), KEEP_BYTES)


def _describe(path: Path) -> str:
    if not path.exists():
        return "missing"
    if not path.is_dir():
        return "not a directory"
    names = sorted(child.name for child in path.iterdir())
    return "contains " + ", ".join(names)


if __name__ == "__main__":
    unittest.main()
