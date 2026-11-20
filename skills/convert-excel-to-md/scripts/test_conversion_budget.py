#!/usr/bin/env python3
"""Security spec for skills/convert-excel-to-md/scripts/convert_excel_to_md.py.

These tests fail while the converter decompresses workbook zip members with no
budget. They are expected to pass only after a fix that, before each zip
member read:

- refuses a member whose ZipInfo.file_size exceeds MAX_MEMBER_UNCOMPRESSED_BYTES
- refuses a member that would push the running total of uncompressed bytes
  already decompressed for that conversion above MAX_TOTAL_UNCOMPRESSED_BYTES
- refuses a sheet that references more than MAX_IMAGES_PER_SHEET images
- raises convert_excel_to_md.ConversionBudgetError (an Exception that is not a
  subclass of OSError, KeyError, zipfile.BadZipFile, or xml.etree.ElementTree.ParseError,
  so the existing handlers do not swallow it)
- does not decompress the refused member (a check of compress_size, of the
  .xlsx file's size on disk, or of ZipInfo.file_size followed by a full read,
  still fails)
- does not write image or markdown output, and does not delete an existing
  output file, when it refuses

The running total is one budget for a single _sheet_name_to_media,
extract_images, or convert_one call. Reads performed by a helper count toward
the caller. Opening the zip a second time does not reset the total.

An unreferenced zip member is not read and does not count. The cap on images
is per sheet.

Not covered here (same missing cap, separate entry points): every zip read in
skills/convert-word-to-md/scripts/convert_word_to_md.py. Batch mode in this
script only loops on convert_one, which these tests call directly.
"""

from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_MEMBER_UNCOMPRESSED_BYTES = 16 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_IMAGES_PER_SHEET = 64

_OVER_MEMBER = MAX_MEMBER_UNCOMPRESSED_BYTES + 1
_PART_UNDER_MEMBER = 6 * 1024 * 1024  # 6 parts = 36 MiB, over the 32 MiB total

_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_SCRIPT = Path(__file__).resolve().parent / "convert_excel_to_md.py"


def _load_converter():
    spec = importlib.util.spec_from_file_location("convert_excel_to_md", _SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


convert_excel_to_md = _load_converter()


class _ReadSpy:
    """Count bytes actually returned by zipfile.ZipExtFile.read.

    ZipFile.read and ZipFile.open both end in that method
    (zipfile/__init__.py ZipFile.read -> ZipExtFile.read). getinfo does not.
    """

    def __init__(self):
        self.per_member: dict[str, int] = {}
        self._orig = None

    def install(self):
        orig = zipfile.ZipExtFile.read

        def wrapped(zef, n=-1):
            data = orig(zef, n)
            name = zef.name
            self.per_member[name] = self.per_member.get(name, 0) + len(data)
            return data

        self._orig = orig
        zipfile.ZipExtFile.read = wrapped
        return self

    def close(self):
        if self._orig is not None:
            zipfile.ZipExtFile.read = self._orig
            self._orig = None

    def reset(self):
        self.per_member.clear()

    @property
    def total(self) -> int:
        return sum(self.per_member.values())


def _pad_xml(raw: bytes, size: int) -> bytes:
    idx = raw.rfind(b"</")
    if idx < 0:
        raise RuntimeError("xml has no closing tag to pad")
    overhead = len(b"<!--") + len(b"-->")
    pad_len = size - len(raw) - overhead
    if pad_len < 0:
        raise RuntimeError(f"xml is already {len(raw)} bytes, above {size}")
    out = raw[:idx] + b"<!--" + (b"A" * pad_len) + b"-->" + raw[idx:]
    if len(out) != size:
        raise RuntimeError(f"padded xml is {len(out)} bytes, wanted {size}")
    return out


def _build_xlsx(
    path: Path,
    *,
    images_per_sheet: list[int] | None = None,
    media: bytes = b"png",
    part_sizes: dict[str, int] | None = None,
    unused_size: int | None = None,
) -> Path:
    """Write a real xlsx (openpyxl) plus drawing relationships the converter walks.

    Media bytes are repeated 'A's when a large size is requested so the zip
    stays small on disk while ZipInfo.file_size is the uncompressed size.
    """
    from openpyxl import Workbook

    counts = images_per_sheet or [1]
    wb = Workbook()
    wb.active.title = "Sheet1"
    wb.active["A1"] = "hello"
    for index in range(2, len(counts) + 1):
        sheet = wb.create_sheet(f"Sheet{index}")
        sheet["A1"] = "x"
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    parts: dict[str, bytes] = {}
    with zipfile.ZipFile(buf) as archive:
        for info in archive.infolist():
            parts[info.filename] = archive.read(info.filename)

    for sheet_index, count in enumerate(counts, start=1):
        sheet_name = f"xl/worksheets/sheet{sheet_index}.xml"
        sheet_xml = parts[sheet_name].decode()
        if "</worksheet>" not in sheet_xml:
            raise RuntimeError(f"{sheet_name} has no worksheet root")
        parts[sheet_name] = sheet_xml.replace(
            "</worksheet>",
            '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'r:id="rId1"/></worksheet>',
        ).encode()
        parts[f"xl/worksheets/_rels/sheet{sheet_index}.xml.rels"] = (
            f'<Relationships xmlns="{_REL_NS}">'
            f'<Relationship Id="rId1" '
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" '
            f'Target="../drawings/drawing{sheet_index}.xml"/>'
            f"</Relationships>"
        ).encode()
        blips = []
        rels = []
        for image_index in range(1, count + 1):
            blips.append(
                '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                f'r:embed="rId{image_index}"/>'
            )
            rels.append(
                f'<Relationship Id="rId{image_index}" '
                f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
                f'Target="../media/sheet{sheet_index}img{image_index}.png"/>'
            )
            parts[f"xl/media/sheet{sheet_index}img{image_index}.png"] = media
        parts[f"xl/drawings/drawing{sheet_index}.xml"] = (
            '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            + "".join(blips)
            + "</xdr:wsDr>"
        ).encode()
        parts[f"xl/drawings/_rels/drawing{sheet_index}.xml.rels"] = (
            f'<Relationships xmlns="{_REL_NS}">' + "".join(rels) + "</Relationships>"
        ).encode()

    if unused_size is not None:
        parts["xl/media/unused.bin"] = b"U" * unused_size

    for name, size in (part_sizes or {}).items():
        if name not in parts:
            raise RuntimeError(f"cannot pad missing part {name}")
        raw = parts[name]
        if name.endswith((".xml", ".rels")):
            parts[name] = _pad_xml(raw, size)
        else:
            if len(raw) > size:
                raise RuntimeError(f"{name} is already {len(raw)} bytes")
            parts[name] = raw + (b"B" * (size - len(raw)))

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return path


def _member(path: Path, name: str) -> zipfile.ZipInfo:
    with zipfile.ZipFile(path) as archive:
        return archive.getinfo(name)


class ConversionBudgetTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.spy = _ReadSpy()
        self.spy.install()
        self.addCleanup(self.spy.close)

    def _budget_error(self):
        exc = getattr(convert_excel_to_md, "ConversionBudgetError", None)
        if not isinstance(exc, type) or not issubclass(exc, Exception):
            self.fail(
                "convert_excel_to_md.ConversionBudgetError must be an Exception subclass"
            )
        for blocked in (OSError, KeyError, zipfile.BadZipFile, ET.ParseError):
            if issubclass(exc, blocked):
                self.fail(
                    "ConversionBudgetError must not subclass "
                    f"{blocked.__name__}; the converter catches that and continues"
                )
        return exc

    def _assert_refused(self, call, label: str):
        """Run call(). A refusal counts only when the oversized bytes were not decompressed."""
        self.spy.reset()
        caught = None
        try:
            result = call()
        except Exception as exc:
            result = None
            caught = exc
        over_member = {
            name: size
            for name, size in self.spy.per_member.items()
            if size > MAX_MEMBER_UNCOMPRESSED_BYTES
        }
        if caught is None:
            self.fail(
                f"{label}: conversion returned {result!r} after decompressing "
                f"{self.spy.total} bytes {self.spy.per_member}"
            )
        if self.spy.total > MAX_TOTAL_UNCOMPRESSED_BYTES or over_member:
            self.fail(
                f"{label}: {type(caught).__name__} happened only after decompressing "
                f"{self.spy.total} bytes; members over the per-member budget: {over_member}; "
                f"all members: {self.spy.per_member}"
            )
        exc_type = self._budget_error()
        self.assertIsInstance(
            caught,
            exc_type,
            f"{label}: {type(caught).__name__}: {caught}",
        )

    def _files(self, directory: Path) -> list[Path]:
        if not directory.exists():
            return []
        return sorted(p for p in directory.rglob("*") if p.is_file())

    def test_member_budget_constants_are_the_spec(self):
        self.assertEqual(MAX_MEMBER_UNCOMPRESSED_BYTES, 16 * 1024 * 1024)
        self.assertEqual(MAX_TOTAL_UNCOMPRESSED_BYTES, 32 * 1024 * 1024)
        self.assertEqual(MAX_IMAGES_PER_SHEET, 64)

    def test_small_workbook_still_extracts_its_image(self):
        xlsx = _build_xlsx(self.root / "small.xlsx", media=b"png-bytes")
        img_dir = self.root / "img"
        self.spy.reset()
        written = convert_excel_to_md.extract_images(xlsx, img_dir)
        self.assertEqual(list(written), ["Sheet1"])
        self.assertEqual(written["Sheet1"], ["sheet001_Sheet1_img001.png"])
        payload = (img_dir / "sheet001_Sheet1_img001.png").read_bytes()
        self.assertEqual(payload, b"png-bytes")
        self.assertGreater(self.spy.per_member.get("xl/media/sheet1img1.png", 0), 0)
        self.assertLessEqual(self.spy.total, MAX_TOTAL_UNCOMPRESSED_BYTES)

    def test_member_at_the_byte_budget_is_extracted(self):
        media = b"A" * MAX_MEMBER_UNCOMPRESSED_BYTES
        xlsx = _build_xlsx(self.root / "exact.xlsx", media=media)
        info = _member(xlsx, "xl/media/sheet1img1.png")
        self.assertEqual(info.file_size, MAX_MEMBER_UNCOMPRESSED_BYTES)
        img_dir = self.root / "img"
        self.spy.reset()
        written = convert_excel_to_md.extract_images(xlsx, img_dir)
        self.assertEqual(written["Sheet1"], ["sheet001_Sheet1_img001.png"])
        self.assertEqual(
            (img_dir / "sheet001_Sheet1_img001.png").stat().st_size,
            MAX_MEMBER_UNCOMPRESSED_BYTES,
        )

    def test_image_count_at_the_per_sheet_cap_is_extracted(self):
        xlsx = _build_xlsx(
            self.root / "cap.xlsx",
            images_per_sheet=[MAX_IMAGES_PER_SHEET],
            media=b"i",
        )
        img_dir = self.root / "img"
        written = convert_excel_to_md.extract_images(xlsx, img_dir)
        self.assertEqual(len(written["Sheet1"]), MAX_IMAGES_PER_SHEET)
        self.assertEqual(len(self._files(img_dir)), MAX_IMAGES_PER_SHEET)

    def test_image_cap_is_per_sheet(self):
        xlsx = _build_xlsx(
            self.root / "two-sheets.xlsx",
            images_per_sheet=[MAX_IMAGES_PER_SHEET, 1],
            media=b"i",
        )
        img_dir = self.root / "img"
        written = convert_excel_to_md.extract_images(xlsx, img_dir)
        self.assertEqual(len(written["Sheet1"]), MAX_IMAGES_PER_SHEET)
        self.assertEqual(len(written["Sheet2"]), 1)

    def test_unreferenced_member_over_the_budget_is_not_read(self):
        xlsx = _build_xlsx(
            self.root / "unused.xlsx",
            media=b"png",
            unused_size=_OVER_MEMBER,
        )
        info = _member(xlsx, "xl/media/unused.bin")
        self.assertGreater(info.file_size, MAX_MEMBER_UNCOMPRESSED_BYTES)
        self.assertLess(info.compress_size, 64 * 1024)
        img_dir = self.root / "img"
        self.spy.reset()
        written = convert_excel_to_md.extract_images(xlsx, img_dir)
        self.assertIn("Sheet1", written)
        self.assertEqual(self.spy.per_member.get("xl/media/unused.bin", 0), 0)
        self.assertLessEqual(self.spy.total, MAX_TOTAL_UNCOMPRESSED_BYTES)

    def test_each_walked_member_over_the_byte_budget_is_refused_before_decompress(self):
        walked = [
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/_rels/sheet1.xml.rels",
            "xl/drawings/_rels/drawing1.xml.rels",
            "xl/drawings/drawing1.xml",
        ]
        for name in walked:
            with self.subTest(member=name):
                xlsx = _build_xlsx(
                    self.root / f"{name.replace('/', '_')}.xlsx",
                    media=b"png",
                    part_sizes={name: _OVER_MEMBER},
                )
                info = _member(xlsx, name)
                self.assertGreater(info.file_size, MAX_MEMBER_UNCOMPRESSED_BYTES)
                self.assertLess(xlsx.stat().st_size, 1024 * 1024)
                self.assertLess(info.compress_size, MAX_MEMBER_UNCOMPRESSED_BYTES // 10)
                img_dir = self.root / f"img-{name.replace('/', '_')}"
                img_dir.mkdir()
                sentinel = img_dir / "sentinel.txt"
                sentinel.write_text("keep")
                self._assert_refused(
                    lambda: convert_excel_to_md.extract_images(xlsx, img_dir),
                    name,
                )
                self.assertEqual(sentinel.read_text(), "keep")
                self.assertEqual(
                    [p.name for p in self._files(img_dir)],
                    ["sentinel.txt"],
                )

        with self.subTest(member="xl/media/sheet1img1.png"):
            media = b"A" * _OVER_MEMBER
            xlsx = _build_xlsx(self.root / "media.xlsx", media=media)
            info = _member(xlsx, "xl/media/sheet1img1.png")
            self.assertEqual(info.file_size, _OVER_MEMBER)
            self.assertLess(info.compress_size, 64 * 1024)
            self.assertLess(xlsx.stat().st_size, 1024 * 1024)
            img_dir = self.root / "img-media"
            img_dir.mkdir()
            sentinel = img_dir / "sentinel.txt"
            sentinel.write_text("keep")
            self._assert_refused(
                lambda: convert_excel_to_md.extract_images(xlsx, img_dir),
                "xl/media/sheet1img1.png",
            )
            self.assertEqual(sentinel.read_text(), "keep")
            self.assertEqual([p.name for p in self._files(img_dir)], ["sentinel.txt"])
            self.assertLessEqual(
                self.spy.per_member.get("xl/media/sheet1img1.png", 0),
                MAX_MEMBER_UNCOMPRESSED_BYTES,
            )

    def test_running_total_across_relationship_walk_refuses_before_extra_decompress(self):
        # Six walked XML parts, each under the per-member cap, together over the total.
        walked = [
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/_rels/sheet1.xml.rels",
            "xl/drawings/_rels/drawing1.xml.rels",
            "xl/drawings/drawing1.xml",
        ]
        xlsx = _build_xlsx(
            self.root / "total-walk.xlsx",
            media=b"png",
            part_sizes={name: _PART_UNDER_MEMBER for name in walked},
        )
        for name in walked:
            info = _member(xlsx, name)
            self.assertLessEqual(info.file_size, MAX_MEMBER_UNCOMPRESSED_BYTES)
            self.assertGreater(info.file_size, 0)
        self.assertGreater(
            sum(_member(xlsx, name).file_size for name in walked),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        )
        self.assertLess(xlsx.stat().st_size, 1024 * 1024)
        self._assert_refused(
            lambda: convert_excel_to_md._sheet_name_to_media(xlsx),
            "relationship walk total",
        )

    def test_running_total_includes_the_second_zip_open_in_extract_images(self):
        # The relationship walk alone stays under the total. Adding the media
        # read, which happens in a second ZipFile, crosses it. Each member stays
        # under the per-member cap, and the on-disk zip stays far smaller.
        walked = [
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/_rels/sheet1.xml.rels",
            "xl/drawings/_rels/drawing1.xml.rels",
            "xl/drawings/drawing1.xml",
        ]
        walk_each = 4 * 1024 * 1024
        media_size = 12 * 1024 * 1024
        self.assertLessEqual(walk_each, MAX_MEMBER_UNCOMPRESSED_BYTES)
        self.assertLessEqual(media_size, MAX_MEMBER_UNCOMPRESSED_BYTES)
        self.assertLessEqual(len(walked) * walk_each, MAX_TOTAL_UNCOMPRESSED_BYTES)
        self.assertLessEqual(media_size, MAX_TOTAL_UNCOMPRESSED_BYTES)
        self.assertGreater(len(walked) * walk_each + media_size, MAX_TOTAL_UNCOMPRESSED_BYTES)
        xlsx = _build_xlsx(
            self.root / "total-extract.xlsx",
            media=b"A" * media_size,
            part_sizes={name: walk_each for name in walked},
        )
        self.assertLess(xlsx.stat().st_size, 1024 * 1024)
        img_dir = self.root / "img-total"
        img_dir.mkdir()
        sentinel = img_dir / "sentinel.txt"
        sentinel.write_text("keep")
        self._assert_refused(
            lambda: convert_excel_to_md.extract_images(xlsx, img_dir),
            "extract_images running total",
        )
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual([p.name for p in self._files(img_dir)], ["sentinel.txt"])

    def test_too_many_images_on_one_sheet_writes_nothing(self):
        xlsx = _build_xlsx(
            self.root / "too-many.xlsx",
            images_per_sheet=[MAX_IMAGES_PER_SHEET + 1],
            media=b"i",
        )
        img_dir = self.root / "img-count"
        img_dir.mkdir()
        sentinel = img_dir / "sentinel.txt"
        sentinel.write_text("keep")
        self._assert_refused(
            lambda: convert_excel_to_md.extract_images(xlsx, img_dir),
            "image count",
        )
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual([p.name for p in self._files(img_dir)], ["sentinel.txt"])

    def test_convert_one_refuses_oversized_media_without_deleting_or_writing(self):
        from markitdown import MarkItDown

        media = b"A" * _OVER_MEMBER
        xlsx = _build_xlsx(self.root / "bomb.xlsx", media=media)
        info = _member(xlsx, "xl/media/sheet1img1.png")
        self.assertGreater(info.file_size, MAX_MEMBER_UNCOMPRESSED_BYTES)
        self.assertLess(info.compress_size, 64 * 1024)
        # MarkItDown's default xlsx path (pandas read_only) does not read media.
        # Conversion must still reach extract_images, then refuse.
        preview = MarkItDown().convert(str(xlsx)).text_content
        self.assertIn("Sheet1", preview)
        dest = self.root / "out"
        (dest / "img").mkdir(parents=True)
        sentinel = dest / "img" / "sentinel.txt"
        sentinel.write_text("keep")
        self._assert_refused(
            lambda: convert_excel_to_md.convert_one(MarkItDown(), xlsx, dest),
            "convert_one",
        )
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual([p.name for p in self._files(dest)], ["sentinel.txt"])
        self.assertLessEqual(
            self.spy.per_member.get("xl/media/sheet1img1.png", 0),
            MAX_MEMBER_UNCOMPRESSED_BYTES,
        )

    def test_cli_refuses_oversized_media_without_writing_output(self):
        media = b"A" * _OVER_MEMBER
        xlsx = _build_xlsx(self.root / "cli.xlsx", media=media)
        dest = self.root / "cli-out"
        (dest / "img").mkdir(parents=True)
        sentinel = dest / "img" / "sentinel.txt"
        sentinel.write_text("keep")
        proc = subprocess.run(
            [sys.executable, str(_SCRIPT), str(xlsx), "-o", str(dest)],
            check=False,
            capture_output=True,
            text=True,
        )
        written = [(p.name, p.stat().st_size) for p in self._files(dest)]
        sentinel_text = sentinel.read_text() if sentinel.exists() else "MISSING"
        problems = []
        if proc.returncode == convert_excel_to_md.EXIT_OK:
            problems.append("exit 0")
        if proc.returncode == convert_excel_to_md.EXIT_MISSING_DEPENDENCY:
            problems.append("missing markitdown")
        if "OK" in proc.stdout:
            problems.append("printed OK")
        if sentinel_text != "keep":
            problems.append(f"sentinel is {sentinel_text!r}")
        if written != [("sentinel.txt", 4)]:
            problems.append(f"output files {written}")
        if problems:
            self.fail(
                "CLI did not refuse the oversized media part before touching output: "
                + "; ".join(problems)
                + f"\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            )


if __name__ == "__main__":
    unittest.main()
