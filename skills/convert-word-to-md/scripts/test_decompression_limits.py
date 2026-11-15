#!/usr/bin/env python3
"""Spec tests for zip-member limits in convert_word_to_md.

The converter must refuse a .docx before it decompresses or writes a member
once any of these ceilings would be exceeded:

* a single member's uncompressed size (ZipInfo.file_size) above
  MAX_MEMBER_BYTES (32 MiB)
* the running total of uncompressed bytes above MAX_TOTAL_BYTES (32 MiB)
* more than MAX_IMAGES (32) extracted images

Refusal must happen before the member is allocated and before any output
side effect (deleting an existing destination, creating the image directory,
or writing an image byte). These tests fail while the converter still calls
zipfile.ZipFile.read on the full member and writes every referenced image.

Run:

    python3 -m unittest skills/convert-word-to-md/scripts/test_decompression_limits.py
"""
import subprocess
import sys
import tempfile
import tracemalloc
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import convert_word_to_md as converter  # noqa: E402

MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_IMAGES = 32
# Peak traced allocation allowed when an oversized member must not be read.
# A 33 MiB member currently traces about 100 MiB inside zipfile.ZipFile.read.
MAX_REFUSAL_TRACE_BYTES = 8 * 1024 * 1024
# Two 20 MiB members trace about 117 MiB when both are read, and about 55 MiB
# when only the first is read. Staying under this ceiling means the second
# member was not decompressed.
MAX_CUMULATIVE_TRACE_BYTES = 90 * 1024 * 1024

OVERSIZE_BYTES = MAX_MEMBER_BYTES + (1 * 1024 * 1024)
UNDER_MEMBER_BYTES = 20 * 1024 * 1024

SCRIPT = Path(__file__).resolve().parent / "convert_word_to_md.py"

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""

_PACKAGE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
_PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"
_V_NS = "urn:schemas-microsoft-com:vml"


def _blip(rel_id: str) -> str:
    return (
        "<w:p><w:r><w:drawing><wp:inline>"
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic><pic:blipFill><a:blip r:embed="{rel_id}"/></pic:blipFill></pic:pic>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    )


def _imagedata(rel_id: str) -> str:
    return (
        f'<w:p><w:r><w:pict><v:shape><v:imagedata r:id="{rel_id}"/></v:shape></w:pict></w:r></w:p>'
    )


def _document_xml(body: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{_W_NS}" xmlns:r="{_R_NS}" xmlns:a="{_A_NS}" '
        f'xmlns:wp="{_WP_NS}" xmlns:pic="{_PIC_NS}" xmlns:v="{_V_NS}">'
        f"<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p>{body}</w:body></w:document>"
    )


def _doc_rels(pairs) -> str:
    rels = []
    for rel_id, target in pairs:
        rels.append(
            f'<Relationship Id="{rel_id}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            f'Target="{target}"/>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(rels)
        + "</Relationships>"
    )


def _write_member(zf: zipfile.ZipFile, name: str, data: bytes, compression: int) -> None:
    info = zipfile.ZipInfo(name)
    info.compress_type = compression
    zf.writestr(info, data)


def _build_docx(path: Path, members) -> None:
    """members is a list of (name, data, compression) written after the package shell."""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("_rels/.rels", _PACKAGE_RELS)
        for name, data, compression in members:
            _write_member(zf, name, data, compression)


def _member_file_size(path: Path, name: str) -> int:
    with zipfile.ZipFile(path) as zf:
        return zf.getinfo(name).file_size


def _output_bytes(directory: Path) -> int:
    if not directory.exists():
        return 0
    return sum(item.stat().st_size for item in directory.rglob("*") if item.is_file())


def _image_files(directory: Path):
    if not directory.exists():
        return []
    return sorted(item for item in directory.rglob("*") if item.is_file())


class DecompressionLimitTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _trace(self, fn):
        tracemalloc.start()
        try:
            try:
                value = fn()
            except MemoryError:
                self.fail("decompression ran until MemoryError")
            except Exception as exc:
                value = exc
        finally:
            _current, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        return value, peak

    def test_document_xml_bzip2_oversize_is_not_decompressed(self):
        docx = self.tmp / "document-xml.docx"
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", b"<Relationships/>", zipfile.ZIP_STORED),
                ("word/document.xml", b"a" * OVERSIZE_BYTES, zipfile.ZIP_BZIP2),
            ],
        )
        self.assertGreater(_member_file_size(docx, "word/document.xml"), MAX_MEMBER_BYTES)
        self.assertLess(docx.stat().st_size, 8192)

        _value, peak = self._trace(lambda: converter._document_order_media(docx))
        self.assertLess(
            peak,
            MAX_REFUSAL_TRACE_BYTES,
            f"word/document.xml was decompressed (traced peak {peak} bytes)",
        )

    def test_document_xml_deflate_oversize_is_not_decompressed(self):
        docx = self.tmp / "document-xml-deflate.docx"
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", b"<Relationships/>", zipfile.ZIP_STORED),
                ("word/document.xml", b"\x00" * OVERSIZE_BYTES, zipfile.ZIP_DEFLATED),
            ],
        )
        self.assertGreater(_member_file_size(docx, "word/document.xml"), MAX_MEMBER_BYTES)

        _value, peak = self._trace(lambda: converter._document_order_media(docx))
        self.assertLess(
            peak,
            MAX_REFUSAL_TRACE_BYTES,
            f"deflated word/document.xml was decompressed (traced peak {peak} bytes)",
        )

    def test_document_rels_oversize_is_not_decompressed(self):
        docx = self.tmp / "rels.docx"
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", b"r" * OVERSIZE_BYTES, zipfile.ZIP_BZIP2),
                ("word/document.xml", b"<w:document/>", zipfile.ZIP_STORED),
            ],
        )
        self.assertGreater(
            _member_file_size(docx, "word/_rels/document.xml.rels"),
            MAX_MEMBER_BYTES,
        )
        self.assertLess(docx.stat().st_size, 8192)

        _value, peak = self._trace(lambda: converter._document_order_media(docx))
        self.assertLess(
            peak,
            MAX_REFUSAL_TRACE_BYTES,
            f"word/_rels/document.xml.rels was decompressed (traced peak {peak} bytes)",
        )

    def test_running_decompressed_total_stops_before_second_member(self):
        docx = self.tmp / "cumulative.docx"
        chunk = b"a" * UNDER_MEMBER_BYTES
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", b"<r>" + chunk + b"</r>", zipfile.ZIP_BZIP2),
                ("word/document.xml", b"<d>" + chunk + b"</d>", zipfile.ZIP_BZIP2),
            ],
        )
        rels_size = _member_file_size(docx, "word/_rels/document.xml.rels")
        doc_size = _member_file_size(docx, "word/document.xml")
        self.assertLess(rels_size, MAX_MEMBER_BYTES)
        self.assertLess(doc_size, MAX_MEMBER_BYTES)
        self.assertGreater(rels_size + doc_size, MAX_TOTAL_BYTES)

        _value, peak = self._trace(lambda: converter._document_order_media(docx))
        self.assertLess(
            peak,
            MAX_CUMULATIVE_TRACE_BYTES,
            f"both members were decompressed (traced peak {peak} bytes, "
            f"limit {MAX_CUMULATIVE_TRACE_BYTES})",
        )

    def test_stored_media_oversize_is_not_written(self):
        docx = self.tmp / "stored-media.docx"
        body = _blip("rIdImage1")
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", _doc_rels([("rIdImage1", "media/image1.png")]).encode(), zipfile.ZIP_STORED),
                ("word/document.xml", _document_xml(body).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", b"\x00" * OVERSIZE_BYTES, zipfile.ZIP_STORED),
            ],
        )
        self.assertGreater(_member_file_size(docx, "word/media/image1.png"), MAX_MEMBER_BYTES)
        img_dir = self.tmp / "stored-img"
        _value, peak = self._trace(lambda: converter._extract_images(docx, img_dir))
        self.assertLess(peak, MAX_REFUSAL_TRACE_BYTES, f"stored media was read (traced peak {peak} bytes)")
        self.assertFalse(img_dir.exists(), "image directory was created before refusal")
        self.assertEqual(_output_bytes(img_dir), 0)

    def test_bzip2_imagedata_oversize_is_not_written(self):
        docx = self.tmp / "imagedata.docx"
        body = _imagedata("rIdImage1")
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", _doc_rels([("rIdImage1", "media/image1.png")]).encode(), zipfile.ZIP_STORED),
                ("word/document.xml", _document_xml(body).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", b"\x00" * OVERSIZE_BYTES, zipfile.ZIP_BZIP2),
            ],
        )
        self.assertGreater(_member_file_size(docx, "word/media/image1.png"), MAX_MEMBER_BYTES)
        self.assertLess(docx.stat().st_size, 8192)
        img_dir = self.tmp / "imagedata-img"
        _value, peak = self._trace(lambda: converter._extract_images(docx, img_dir))
        self.assertLess(peak, MAX_REFUSAL_TRACE_BYTES, f"imagedata media was read (traced peak {peak} bytes)")
        self.assertFalse(img_dir.exists(), "image directory was created before refusal")
        self.assertEqual(_output_bytes(img_dir), 0)

    def test_repeated_references_do_not_exceed_image_or_byte_budget(self):
        docx = self.tmp / "repeated.docx"
        repeats = MAX_IMAGES + 8
        body = "".join(_blip("rIdImage1") for _ in range(repeats))
        payload = b"\x00" * (2 * 1024 * 1024)
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", _doc_rels([("rIdImage1", "media/image1.png")]).encode(), zipfile.ZIP_STORED),
                ("word/document.xml", _document_xml(body).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", payload, zipfile.ZIP_BZIP2),
            ],
        )
        img_dir = self.tmp / "repeated-img"
        try:
            converter._extract_images(docx, img_dir)
        except MemoryError:
            self.fail("repeated image extraction ran until MemoryError")
        except Exception:
            pass
        files = _image_files(img_dir)
        self.assertLessEqual(len(files), MAX_IMAGES, f"wrote {len(files)} images")
        self.assertLessEqual(_output_bytes(img_dir), MAX_TOTAL_BYTES)

    def test_separate_media_members_share_one_byte_budget(self):
        docx = self.tmp / "two-members.docx"
        body = _blip("rIdImage1") + _blip("rIdImage2")
        chunk = b"\x00" * UNDER_MEMBER_BYTES
        _build_docx(
            docx,
            [
                (
                    "word/_rels/document.xml.rels",
                    _doc_rels(
                        [
                            ("rIdImage1", "media/image1.png"),
                            ("rIdImage2", "media/image2.png"),
                        ]
                    ).encode(),
                    zipfile.ZIP_STORED,
                ),
                ("word/document.xml", _document_xml(body).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", chunk, zipfile.ZIP_BZIP2),
                ("word/media/image2.png", chunk, zipfile.ZIP_BZIP2),
            ],
        )
        first = _member_file_size(docx, "word/media/image1.png")
        second = _member_file_size(docx, "word/media/image2.png")
        self.assertLess(first, MAX_MEMBER_BYTES)
        self.assertLess(second, MAX_MEMBER_BYTES)
        self.assertGreater(first + second, MAX_TOTAL_BYTES)

        img_dir = self.tmp / "two-img"
        try:
            converter._extract_images(docx, img_dir)
        except MemoryError:
            self.fail("media extraction ran until MemoryError")
        except Exception:
            pass
        self.assertLessEqual(_output_bytes(img_dir), MAX_TOTAL_BYTES)
        for image in _image_files(img_dir):
            self.assertLessEqual(image.stat().st_size, MAX_MEMBER_BYTES)

    def test_convert_one_refuses_oversize_media_without_side_effects(self):
        from markitdown import MarkItDown

        md = MarkItDown()
        docx = self.tmp / "convert-one.docx"
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", _doc_rels([("rIdImage1", "media/image1.png")]).encode(), zipfile.ZIP_STORED),
                ("word/document.xml", _document_xml(_blip("rIdImage1")).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", b"\x00" * OVERSIZE_BYTES, zipfile.ZIP_BZIP2),
            ],
        )
        self.assertGreater(_member_file_size(docx, "word/media/image1.png"), MAX_MEMBER_BYTES)
        self.assertLess(docx.stat().st_size, 8192)

        dest = self.tmp / "dest"
        dest.mkdir()
        sentinel = dest / "sentinel.txt"
        sentinel.write_text("keep")

        value, peak = self._trace(lambda: converter.convert_one(md, docx, dest))
        self.assertLess(
            peak,
            MAX_REFUSAL_TRACE_BYTES,
            f"convert_one decompressed the media member (traced peak {peak} bytes)",
        )
        if not isinstance(value, Exception):
            self.assertFalse(value)
        self.assertTrue(sentinel.exists(), "destination was deleted before refusal")
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual({item.name for item in dest.iterdir()}, {"sentinel.txt"})

    def test_cli_refuses_oversize_media_without_side_effects(self):
        docx = self.tmp / "cli-oversize.docx"
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", _doc_rels([("rIdImage1", "media/image1.png")]).encode(), zipfile.ZIP_STORED),
                ("word/document.xml", _document_xml(_blip("rIdImage1")).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", b"\x00" * OVERSIZE_BYTES, zipfile.ZIP_BZIP2),
            ],
        )
        dest = self.tmp / "cli-dest"
        dest.mkdir()
        sentinel = dest / "sentinel.txt"
        sentinel.write_text("keep")

        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(docx), "-o", str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue(sentinel.exists(), "CLI deleted the destination before refusal")
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual({item.name for item in dest.iterdir()}, {"sentinel.txt"})

    def test_cli_repeated_references_do_not_exceed_image_budget(self):
        docx = self.tmp / "cli-repeated.docx"
        repeats = MAX_IMAGES + 8
        body = "".join(_blip("rIdImage1") for _ in range(repeats))
        _build_docx(
            docx,
            [
                ("word/_rels/document.xml.rels", _doc_rels([("rIdImage1", "media/image1.png")]).encode(), zipfile.ZIP_STORED),
                ("word/document.xml", _document_xml(body).encode(), zipfile.ZIP_STORED),
                ("word/media/image1.png", b"\x00" * 1024, zipfile.ZIP_STORED),
            ],
        )
        dest = self.tmp / "cli-repeated-dest"
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(docx), "-o", str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        files = _image_files(dest / "img")
        if proc.returncode != 0:
            self.assertEqual(files, [])
            return
        self.assertLessEqual(len(files), MAX_IMAGES, proc.stdout + proc.stderr)
        self.assertLessEqual(_output_bytes(dest / "img"), MAX_TOTAL_BYTES)


if __name__ == "__main__":
    unittest.main()
