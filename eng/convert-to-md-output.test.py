"""Regression: the convert-*-to-md scripts must never delete or write into a
folder they did not create, including the source's own folder."""

import contextlib
import importlib.util
import io
import pathlib
import sys
import tempfile
import types
import unittest
import zipfile
import unittest.mock as mock

ROOT = pathlib.Path(__file__).parents[1]

# Loading the skill scripts must not leave __pycache__ inside skill folders,
# which the build would then list as skill assets.
sys.dont_write_bytecode = True

_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

IMAGE_BYTES = b"\x89PNG-test-image"
USER_PHOTO = b"user photo that must survive"


def load_script(skill, script):
    path = ROOT / "skills" / skill / "scripts" / script
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_markitdown(text):
    class FakeMarkItDown:
        def convert(self, _path):
            return types.SimpleNamespace(text_content=text)

    return FakeMarkItDown


def fake_fitz():
    class Page:
        def get_images(self, full=False):
            return [(1,)]

        def get_text(self, _kind, flags=0):
            return {"blocks": []}

    class Doc:
        def __len__(self):
            return 1

        def __getitem__(self, _index):
            return Page()

        def extract_image(self, _xref):
            return {"image": IMAGE_BYTES, "ext": "png"}

        def close(self):
            pass

    return types.SimpleNamespace(open=lambda _path: Doc(), TEXT_PRESERVE_IMAGES=0)


def write_xlsx(path):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(
            "xl/workbook.xml",
            f'<workbook xmlns="{_MAIN_NS}" xmlns:r="{_R_NS}"><sheets>'
            '<sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            f'<Relationships xmlns="{_REL_NS}">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        z.writestr(
            "xl/worksheets/sheet1.xml",
            f'<worksheet xmlns="{_MAIN_NS}" xmlns:r="{_R_NS}"><drawing r:id="rId1"/></worksheet>',
        )
        z.writestr(
            "xl/worksheets/_rels/sheet1.xml.rels",
            f'<Relationships xmlns="{_REL_NS}">'
            '<Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>',
        )
        z.writestr(
            "xl/drawings/drawing1.xml",
            f'<wsDr xmlns:a="{_A_NS}" xmlns:r="{_R_NS}"><a:blip r:embed="rId1"/></wsDr>',
        )
        z.writestr(
            "xl/drawings/_rels/drawing1.xml.rels",
            f'<Relationships xmlns="{_REL_NS}">'
            '<Relationship Id="rId1" Target="../media/image1.png"/></Relationships>',
        )
        z.writestr("xl/media/image1.png", IMAGE_BYTES)


def write_docx(path):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(
            "word/document.xml",
            f'<w:document xmlns:w="{_W_NS}" xmlns:a="{_A_NS}" xmlns:r="{_R_NS}">'
            '<w:body><a:blip r:embed="rId1"/></w:body></w:document>',
        )
        z.writestr(
            "word/_rels/document.xml.rels",
            f'<Relationships xmlns="{_REL_NS}">'
            '<Relationship Id="rId1" Target="media/image1.png"/></Relationships>',
        )
        z.writestr("word/media/image1.png", IMAGE_BYTES)


def write_pdf(path):
    path.write_bytes(b"%PDF-1.4 placeholder")


class ConverterOutputSafety:
    """Mixin; subclasses set skill, script, ext, write_source, markdown."""

    skill = script = ext = markdown = None
    write_source = None

    def setUp(self):
        self.module = load_script(self.skill, self.script)
        self.module._import_markitdown = lambda: fake_markitdown(self.markdown)
        if hasattr(self.module, "_import_fitz"):
            self.module._import_fitz = fake_fitz
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = pathlib.Path(tmp.name)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", [self.script, *map(str, argv)]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.module.main()
        return code, out.getvalue() + err.getvalue()

    def make_source(self, folder, name):
        folder.mkdir(parents=True, exist_ok=True)
        source = folder / f"{name}{self.ext}"
        type(self).write_source(source)
        return source

    def make_user_folder(self, folder):
        (folder / "img").mkdir(parents=True, exist_ok=True)
        (folder / "img" / "photo.jpg").write_bytes(USER_PHOTO)
        (folder / "notes.txt").write_text("keep me", encoding="utf-8")

    def assert_user_folder_untouched(self, folder, extra_allowed=()):
        self.assertEqual((folder / "img" / "photo.jpg").read_bytes(), USER_PHOTO)
        self.assertEqual((folder / "notes.txt").read_text(encoding="utf-8"), "keep me")
        self.assertEqual(sorted(p.name for p in (folder / "img").iterdir()), ["photo.jpg"])
        expected = sorted({"img", "notes.txt", *extra_allowed})
        self.assertEqual(sorted(p.name for p in folder.iterdir()), expected)

    def test_existing_folder_with_source_stem_is_not_modified(self):
        source = self.make_source(self.tmp, "report")
        self.make_user_folder(self.tmp / "report")

        code, output = self.run_main(source)

        self.assert_user_folder_untouched(self.tmp / "report")
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    def test_dot_stem_does_not_target_source_folder(self):
        folder = self.tmp / "holiday"
        source = self.make_source(folder, ".")
        self.make_user_folder(folder)

        code, output = self.run_main(source)

        self.assertTrue(source.exists())
        self.assert_user_folder_untouched(folder, extra_allowed=[source.name])
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    def test_double_dot_stem_does_not_target_parent_folder(self):
        folder = self.tmp / "holiday"
        source = self.make_source(folder / "inbox", "..")
        self.make_user_folder(folder)

        code, output = self.run_main(source)

        self.assertTrue(source.exists())
        self.assert_user_folder_untouched(folder, extra_allowed=["inbox"])
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    def test_batch_dot_stem_does_not_target_source_folder(self):
        folder = self.tmp / "holiday"
        source = self.make_source(folder, ".")
        self.make_user_folder(folder)

        code, output = self.run_main(folder)

        self.assertTrue(source.exists())
        self.assert_user_folder_untouched(folder, extra_allowed=[source.name])
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    def test_batch_existing_folder_is_not_modified_and_others_convert(self):
        folder = self.tmp / "docs"
        self.make_source(folder, "report")
        self.make_source(folder, "other")
        self.make_user_folder(folder / "report")

        code, output = self.run_main(folder)

        self.assert_user_folder_untouched(folder / "report")
        self.assertTrue((folder / "other" / "other.md").is_file())
        self.assertEqual(code, self.module.EXIT_CONVERSION_FAILED, output)

    def test_batch_output_parent_existing_folder_is_not_modified(self):
        folder = self.tmp / "docs"
        out = self.tmp / "out"
        self.make_source(folder, "report")
        self.make_user_folder(out / "report")

        code, output = self.run_main(folder, "-o", out)

        self.assert_user_folder_untouched(out / "report")
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    def test_existing_output_folder_is_not_modified(self):
        source = self.make_source(self.tmp, "report")
        out = self.tmp / "pictures"
        self.make_user_folder(out)

        code, output = self.run_main(source, "-o", out)

        self.assert_user_folder_untouched(out)
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    @unittest.skipUnless(hasattr(pathlib.Path, "symlink_to") and sys.platform != "win32",
                         "needs POSIX symlinks")
    def test_symlink_at_destination_is_not_followed(self):
        source = self.make_source(self.tmp, "report")
        target = self.tmp / "pictures"
        self.make_user_folder(target)
        (self.tmp / "report").symlink_to(target, target_is_directory=True)

        code, output = self.run_main(source)

        self.assert_user_folder_untouched(target)
        self.assertNotEqual(code, self.module.EXIT_OK, output)

    def test_failed_write_leaves_no_folder_and_a_retry_succeeds(self):
        source = self.make_source(self.tmp, "report")
        real_open = open
        failed = {"n": 0}

        def flaky_open(path, mode="r", *args, **kwargs):
            if "x" in mode and str(path).endswith(".md") and failed["n"] == 0:
                failed["n"] += 1
                raise OSError("simulated write failure")
            return real_open(path, mode, *args, **kwargs)

        with mock.patch("builtins.open", flaky_open):
            code, output = self.run_main(source)

        self.assertNotEqual(code, self.module.EXIT_OK, output)
        self.assertFalse((self.tmp / "report").exists(), output)
        self.assertEqual(
            [p.name for p in self.tmp.iterdir() if p.name.startswith(".")],
            [],
            "a failed conversion left a private staging directory",
        )

        code, output = self.run_main(source)

        self.assertEqual(code, self.module.EXIT_OK, output)
        self.assertTrue((self.tmp / "report" / "report.md").is_file())

    def test_new_output_folder_gets_markdown_and_images(self):
        source = self.make_source(self.tmp, "report")

        code, output = self.run_main(source)

        self.assertEqual(code, self.module.EXIT_OK, output)
        dest = self.tmp / "report"
        self.assertEqual(sorted(p.name for p in dest.iterdir()), ["img", "report.md"])
        images = list((dest / "img").iterdir())
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].read_bytes(), IMAGE_BYTES)
        self.assertIn(f"img/{images[0].name}", (dest / "report.md").read_text(encoding="utf-8"))

    def test_new_nested_output_folder_is_created(self):
        source = self.make_source(self.tmp, "report")
        out = self.tmp / "a" / "b" / "result"

        code, output = self.run_main(source, "-o", out)

        self.assertEqual(code, self.module.EXIT_OK, output)
        self.assertTrue((out / "report.md").is_file())


class ExcelOutputSafety(ConverterOutputSafety, unittest.TestCase):
    skill = "convert-excel-to-md"
    script = "convert_excel_to_md.py"
    ext = ".xlsx"
    write_source = staticmethod(write_xlsx)
    markdown = "## Sheet1\n\n| a |\n|---|\n| 1 |\n"


class WordOutputSafety(ConverterOutputSafety, unittest.TestCase):
    skill = "convert-word-to-md"
    script = "convert_word_to_md.py"
    ext = ".docx"
    write_source = staticmethod(write_docx)
    markdown = "Intro\n\n![chart](data:image/png;base64...)\n"


class PdfOutputSafety(ConverterOutputSafety, unittest.TestCase):
    skill = "convert-pdf-to-md"
    script = "convert_pdf_to_md.py"
    ext = ".pdf"
    write_source = staticmethod(write_pdf)
    markdown = "Page text\n"


if __name__ == "__main__":
    unittest.main()
