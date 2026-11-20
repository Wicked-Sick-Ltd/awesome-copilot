"""Regression tests for convert_pdf_to_md.py output-folder handling.

Run from the repository root with:
    python -B -m unittest discover -s skills/convert-pdf-to-md/tests -v

MarkItDown and PyMuPDF are replaced with stubs so the tests need only the
standard library; everything else (path derivation, writing and replacing
the output folder) runs the real script code.
"""
import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
import unittest.mock as mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "convert_pdf_to_md.py"


class _FakeResult:
    text_content = "# Title\n\nBody text\n"


class _FakeMarkItDown:
    def convert(self, path):
        return _FakeResult()


class _FakePage:
    def get_images(self, full=False):
        return [(1,)]

    def get_text(self, kind, flags=0):
        return {"blocks": []}


class _FakeDoc:
    def __init__(self, path):
        self.image = Path(path).read_bytes()

    def __len__(self):
        return 1

    def __getitem__(self, index):
        return _FakePage()

    def extract_image(self, xref):
        return {"image": self.image, "ext": "png"}

    def close(self):
        pass


def _fake_fitz():
    fitz = types.ModuleType("fitz")
    fitz.TEXT_PRESERVE_IMAGES = 0
    fitz.open = _FakeDoc
    return fitz


def _load_module():
    spec = importlib.util.spec_from_file_location("convert_pdf_to_md_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_pdf(path: Path, image_bytes=b"\x89PNG-one"):
    path.write_bytes(image_bytes)


class ConvertPdfOutputTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_module()
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        markitdown = types.ModuleType("markitdown")
        markitdown.MarkItDown = _FakeMarkItDown
        patcher = mock.patch.dict(sys.modules, {"markitdown": markitdown, "fitz": _fake_fitz()})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["convert_pdf_to_md.py", *map(str, argv)]), \
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

    def test_dot_stem_does_not_delete_containing_folder(self):
        folder = self.make_user_folder()
        _write_pdf(folder / "..pdf")

        code, _, err = self.run_main(folder / "..pdf")

        self.assert_user_folder_intact(folder)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertIn("FAILED", err)

    def test_double_dot_stem_does_not_delete_grandparent(self):
        outer = self.make_user_folder("outer")
        (outer / "docs").mkdir()
        _write_pdf(outer / "docs" / "...pdf")

        code, _, _ = self.run_main(outer / "docs" / "...pdf")

        self.assert_user_folder_intact(outer)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_dot_stem_in_batch_mode_does_not_delete_source_folder(self):
        folder = self.make_user_folder()
        _write_pdf(folder / "..pdf")
        _write_pdf(folder / "report.pdf")

        code, _, _ = self.run_main(folder)

        self.assert_user_folder_intact(folder)
        self.assertTrue((folder / "report" / "report.md").is_file())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_output_flag_does_not_delete_existing_user_folder(self):
        folder = self.make_user_folder()
        _write_pdf(self.tmp / "report.pdf")

        code, _, _ = self.run_main(self.tmp / "report.pdf", "-o", folder)

        self.assert_user_folder_intact(folder)
        self.assertFalse((folder / "report.md").exists())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_sibling_folder_named_like_document_is_kept(self):
        folder = self.make_user_folder("report")
        _write_pdf(self.tmp / "report.pdf")

        code, _, _ = self.run_main(self.tmp / "report.pdf")

        self.assert_user_folder_intact(folder)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_inspect_failure_during_replace_keeps_earlier_output(self):
        source = self.tmp / "report.pdf"
        _write_pdf(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        dest = self.tmp / "report"
        earlier = (dest / "report.md").read_text(encoding="utf-8")
        real_owned = self.module._owned_files

        def flaky(folder, stem):
            if Path(folder).name == "previous":
                raise OSError("simulated inspect failure")
            return real_owned(folder, stem)

        with mock.patch.object(self.module, "_owned_files", flaky):
            code, _, _ = self.run_main(source)

        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertTrue(dest.is_dir())
        self.assertEqual((dest / "report.md").read_text(encoding="utf-8"), earlier)

    def test_destination_swapped_after_check_is_restored_not_deleted(self):
        source = self.tmp / "report.pdf"
        _write_pdf(source)
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

    def test_fresh_conversion_and_rerun(self):
        source = self.tmp / "report.pdf"
        _write_pdf(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        dest = self.tmp / "report"
        self.assertIn("![page001_img001.png](img/page001_img001.png)",
                      (dest / "report.md").read_text(encoding="utf-8"))
        (dest / "img" / "page002_img001.png").write_bytes(b"stale")
        _write_pdf(source, b"\x89PNG-two")

        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)

        self.assertEqual(sorted(os.listdir(dest / "img")), ["page001_img001.png"])
        self.assertEqual((dest / "img" / "page001_img001.png").read_bytes(), b"\x89PNG-two")
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["report", "report.pdf"])


if __name__ == "__main__":
    unittest.main()
