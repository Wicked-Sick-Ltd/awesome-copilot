"""Regression tests for convert_excel_to_md.py output-folder handling.

Run from the repository root with:
    python -B -m unittest discover -s skills/convert-excel-to-md/tests -v

MarkItDown is replaced with a stub so the tests need only the standard
library; everything else (path derivation, image extraction, writing and
replacing the output folder) runs the real script code.
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
import zipfile
from pathlib import Path
import unittest.mock as mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "convert_excel_to_md.py"
IMAGE = "sheet001_Sheet1_img001.png"


class _FakeResult:
    text_content = "## Sheet1\n\n| a |\n|---|\n| 1 |\n"


class _FakeMarkItDown:
    def convert(self, path):
        return _FakeResult()


def _load_module():
    spec = importlib.util.spec_from_file_location("convert_excel_to_md_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_xlsx(path: Path, image_bytes=b"\x89PNG-one"):
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.xml",
                   f'<workbook xmlns="{main}" xmlns:r="{r}"><sheets>'
                   '<sheet name="Sheet1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   f'<Relationships xmlns="{rel}">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml",
                   f'<worksheet xmlns="{main}" xmlns:r="{r}"><drawing r:id="rId1"/></worksheet>')
        z.writestr("xl/worksheets/_rels/sheet1.xml.rels",
                   f'<Relationships xmlns="{rel}">'
                   '<Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>')
        z.writestr("xl/drawings/drawing1.xml",
                   f'<wsDr xmlns:a="{a}" xmlns:r="{r}"><a:blip r:embed="rId1"/></wsDr>')
        z.writestr("xl/drawings/_rels/drawing1.xml.rels",
                   f'<Relationships xmlns="{rel}">'
                   '<Relationship Id="rId1" Target="../media/image1.png"/></Relationships>')
        z.writestr("xl/media/image1.png", image_bytes)


class ConvertExcelOutputTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_module()
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        markitdown = types.ModuleType("markitdown")
        markitdown.MarkItDown = _FakeMarkItDown
        patcher = mock.patch.dict(sys.modules, {"markitdown": markitdown})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["convert_excel_to_md.py", *map(str, argv)]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.module.main()
        return code, out.getvalue(), err.getvalue()

    def make_user_folder(self, name="project"):
        folder = self.tmp / name
        (folder / "img").mkdir(parents=True)
        (folder / "README.md").write_text("keep me", encoding="utf-8")
        (folder / "img" / "logo.png").write_bytes(b"user image")
        return folder

    def assert_user_folder_intact(self, folder):
        self.assertTrue((folder / "README.md").is_file(), f"{folder} lost README.md")
        self.assertTrue((folder / "img" / "logo.png").is_file(), f"{folder} lost img/")
        self.assertEqual((folder / "img" / "logo.png").read_bytes(), b"user image")

    def test_dot_stem_does_not_delete_img_folder_next_to_workbook(self):
        folder = self.make_user_folder()
        _write_xlsx(folder / "..xlsx")

        code, _, err = self.run_main(folder / "..xlsx")

        self.assert_user_folder_intact(folder)
        self.assertFalse((folder / ".md").exists())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertIn("FAILED", err)

    def test_double_dot_stem_does_not_touch_grandparent(self):
        outer = self.make_user_folder("outer")
        (outer / "docs").mkdir()
        _write_xlsx(outer / "docs" / "...xlsx")

        code, _, _ = self.run_main(outer / "docs" / "...xlsx")

        self.assert_user_folder_intact(outer)
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_output_flag_does_not_delete_img_folder_of_existing_user_folder(self):
        folder = self.make_user_folder()
        _write_xlsx(self.tmp / "book.xlsx")

        code, _, _ = self.run_main(self.tmp / "book.xlsx", "-o", folder)

        self.assert_user_folder_intact(folder)
        self.assertFalse((folder / "book.md").exists())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)

    def test_inspect_failure_during_replace_keeps_earlier_output(self):
        source = self.tmp / "book.xlsx"
        _write_xlsx(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        dest = self.tmp / "book"
        earlier = (dest / "book.md").read_text(encoding="utf-8")
        real_owned = self.module._owned_files

        def flaky(folder, stem):
            if Path(folder).name == "previous":
                raise OSError("simulated inspect failure")
            return real_owned(folder, stem)

        with mock.patch.object(self.module, "_owned_files", flaky):
            code, _, _ = self.run_main(source)

        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED)
        self.assertTrue(dest.is_dir())
        self.assertEqual((dest / "book.md").read_text(encoding="utf-8"), earlier)

    def test_destination_swapped_after_check_is_restored_not_deleted(self):
        source = self.tmp / "book.xlsx"
        _write_xlsx(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        dest = self.tmp / "book"
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
        source = self.tmp / "book.xlsx"
        _write_xlsx(source)
        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)
        dest = self.tmp / "book"
        self.assertIn(f"![{IMAGE}](img/{IMAGE})", (dest / "book.md").read_text(encoding="utf-8"))
        (dest / "img" / "sheet002_Old_img001.png").write_bytes(b"stale")
        _write_xlsx(source, b"\x89PNG-two")

        self.assertEqual(self.run_main(source)[0], self.module.EXIT_OK)

        self.assertEqual(sorted(os.listdir(dest / "img")), [IMAGE])
        self.assertEqual((dest / "img" / IMAGE).read_bytes(), b"\x89PNG-two")
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["book", "book.xlsx"])


if __name__ == "__main__":
    unittest.main()
