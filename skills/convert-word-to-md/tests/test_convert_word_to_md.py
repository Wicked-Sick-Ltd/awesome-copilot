"""Regression tests for convert_word_to_md.py output-folder handling.

Run from the repository root with:
    python -B -m unittest discover -s skills/convert-word-to-md/tests -v

MarkItDown is replaced with a stub so the tests need only the standard
library; everything else (path derivation, image extraction, writing and
replacing the output folder) runs the real script code.
"""
import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "convert_word_to_md.py"
PLACEHOLDER = "![pic](data:image/png;base64...)"


class _FakeResult:
    def __init__(self, text):
        self.text_content = text


class _FakeMarkItDown:
    text = f"# Title\n\n{PLACEHOLDER}\n"

    def convert(self, path):
        return _FakeResult(_FakeMarkItDown.text)


def _load_module():
    spec = importlib.util.spec_from_file_location("convert_word_to_md_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_docx(path: Path, image_bytes=b"\x89PNG-one"):
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    document = (
        f'<w:document xmlns:w="{w}" xmlns:a="{a}" xmlns:r="{r}"><w:body><w:p><w:r>'
        '<a:blip r:embed="rId1"/></w:r></w:p></w:body></w:document>'
    )
    rels = (
        f'<Relationships xmlns="{rel}">'
        '<Relationship Id="rId1" Target="media/image1.png"/></Relationships>'
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", document)
        z.writestr("word/_rels/document.xml.rels", rels)
        z.writestr("word/media/image1.png", image_bytes)


class ConvertWordOutputTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_module()
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(self._cleanup)
        fake = types.ModuleType("markitdown")
        fake.MarkItDown = _FakeMarkItDown
        patcher = mock.patch.dict(sys.modules, {"markitdown": fake})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["convert_word_to_md.py", *map(str, argv)]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.module.main()
        return code, out.getvalue(), err.getvalue()

    def make_user_folder(self, name="project"):
        folder = self.tmp / name
        (folder / "src").mkdir(parents=True)
        (folder / "README.md").write_text("keep me", encoding="utf-8")
        (folder / "src" / "main.py").write_text("print('keep')", encoding="utf-8")
        return folder

    def assert_user_folder_intact(self, folder):
        self.assertTrue((folder / "README.md").is_file(), f"{folder} was emptied")
        self.assertTrue((folder / "src" / "main.py").is_file(), f"{folder} was emptied")
        self.assertEqual((folder / "README.md").read_text(encoding="utf-8"), "keep me")
        self.assertEqual((folder / "src" / "main.py").read_text(encoding="utf-8"), "print('keep')")

    def test_dot_stem_does_not_delete_containing_folder(self):
        folder = self.make_user_folder()
        _write_docx(folder / "..docx")

        code, _, err = self.run_main(folder / "..docx")

        self.assert_user_folder_intact(folder)
        self.assertTrue((folder / "..docx").exists())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertIn("FAILED", err)

    def test_double_dot_stem_does_not_delete_grandparent(self):
        outer = self.make_user_folder("outer")
        inner = outer / "docs"
        inner.mkdir()
        _write_docx(inner / "...docx")

        code, _, _ = self.run_main(inner / "...docx")

        self.assert_user_folder_intact(outer)
        self.assertTrue((inner / "...docx").exists())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_dot_stem_in_batch_mode_does_not_delete_source_folder(self):
        folder = self.make_user_folder()
        _write_docx(folder / "..docx")
        _write_docx(folder / "report.docx")

        code, _, _ = self.run_main(folder)

        self.assert_user_folder_intact(folder)
        self.assertTrue((folder / "report" / "report.md").is_file())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_output_flag_does_not_delete_existing_user_folder(self):
        folder = self.make_user_folder()
        source = self.tmp / "report.docx"
        _write_docx(source)

        code, _, err = self.run_main(source, "-o", folder)

        self.assert_user_folder_intact(folder)
        self.assertFalse((folder / "report.md").exists())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertIn("FAILED", err)

    def test_sibling_folder_named_like_document_is_kept(self):
        folder = self.make_user_folder("report")
        _write_docx(self.tmp / "report.docx")

        code, _, _ = self.run_main(self.tmp / "report.docx")

        self.assert_user_folder_intact(folder)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_planted_marker_does_not_authorize_deleting_other_files(self):
        folder = self.make_user_folder("report")
        (folder / ".convert-word-to-md").write_text("", encoding="utf-8")
        _write_docx(self.tmp / "report.docx")

        code, _, _ = self.run_main(self.tmp / "report.docx")

        self.assert_user_folder_intact(folder)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlinked_destination_is_not_followed(self):
        folder = self.make_user_folder()
        _write_docx(self.tmp / "report.docx")
        try:
            (self.tmp / "report").symlink_to(folder, target_is_directory=True)
        except OSError:
            self.skipTest("cannot create symlinks here")

        code, _, _ = self.run_main(self.tmp / "report.docx")

        self.assert_user_folder_intact(folder)
        self.assertTrue((self.tmp / "report").is_symlink())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_destination_swapped_after_check_is_restored_not_deleted(self):
        source = self.tmp / "report.docx"
        _write_docx(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        dest = self.tmp / "report"
        victim = self.make_user_folder("victim")
        real_rename = os.rename
        swapped = []

        def racing_rename(src, dst, *args, **kwargs):
            if not swapped and Path(src) == dest:
                swapped.append(True)
                real_rename(dest, self.tmp / "earlier-output")
                real_rename(victim, dest)
            return real_rename(src, dst, *args, **kwargs)

        with mock.patch.object(os, "rename", racing_rename):
            code, _, _ = self.run_main(source)

        self.assertTrue(swapped)
        self.assert_user_folder_intact(dest)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertEqual([p.name for p in self.tmp.iterdir() if p.name.startswith(".")], [])

    def test_fresh_conversion_writes_markdown_and_images(self):
        source = self.tmp / "report.docx"
        _write_docx(source)

        code, out, _ = self.run_main(source)

        self.assertEqual(code, self.module.EXIT_OK)
        dest = self.tmp / "report"
        self.assertEqual(
            (dest / "report.md").read_text(encoding="utf-8"),
            "# Title\n\n![pic](img/img001.png)\n",
        )
        self.assertEqual((dest / "img" / "img001.png").read_bytes(), b"\x89PNG-one")
        self.assertIn("OK", out)

    def test_rerun_replaces_earlier_output(self):
        source = self.tmp / "report.docx"
        _write_docx(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        _write_docx(source, image_bytes=b"\x89PNG-two")

        code, _, _ = self.run_main(source)

        self.assertEqual(code, self.module.EXIT_OK)
        self.assertEqual((self.tmp / "report" / "img" / "img001.png").read_bytes(), b"\x89PNG-two")
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["report", "report.docx"])

    def test_rerun_drops_stale_images(self):
        source = self.tmp / "report.docx"
        _write_docx(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        (self.tmp / "report" / "img" / "img002.png").write_bytes(b"stale")

        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)

        self.assertEqual(sorted(os.listdir(self.tmp / "report" / "img")), ["img001.png"])

    def test_output_flag_accepts_new_or_empty_folder(self):
        source = self.tmp / "report.docx"
        _write_docx(source)
        empty = self.tmp / "empty"
        empty.mkdir()

        self.assertEqual(self.run_main(source, "-o", empty)[0], self.module.EXIT_OK)
        self.assertEqual(self.run_main(source, "-o", self.tmp / "new" / "out")[0], self.module.EXIT_OK)

        self.assertTrue((empty / "report.md").is_file())
        self.assertTrue((self.tmp / "new" / "out" / "report.md").is_file())


if __name__ == "__main__":
    unittest.main()
