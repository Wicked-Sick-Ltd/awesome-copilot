#!/usr/bin/env python3
"""Convert Excel (.xlsx) workbooks to Markdown using Microsoft's MarkItDown,
with embedded images extracted to real files and placed under the correct
sheet (MarkItDown's XLSX converter only extracts sheet data as tables -- it
has no support for embedded images at all).

Usage:
    python convert_excel_to_md.py <input> [-o OUTPUT] [--recursive]

<input> may be either:
  - a path to a single .xlsx file, or
  - a path to a directory (batch mode: every .xlsx file directly inside it
    is converted; pass --recursive to also descend into subdirectories).

Output:
  For each source .xlsx (named "<name>.xlsx"), a folder is created
  containing the Markdown and its images, in this layout:

      <name>/
          img/
              Sheet1_img001.<ext>
              Sheet2_img001.<ext>
              ...
          <name>.md

  MarkItDown renders each sheet as its own "## <SheetName>" section with a
  Markdown table. This script independently maps embedded images to the
  sheet they belong to (via the .xlsx zip's drawing relationships) and
  inserts a "#### Images in this sheet" block right after that sheet's
  table, before the next "## " heading. This is per-sheet placement (not
  exact cell position), which is the finest granularity MarkItDown's stable
  output anchors allow.

  - Single file mode: the "<name>/" folder is created next to the source
    file, or at -o/--output (treated as the exact destination folder) if
    given.
  - Batch/directory mode: a "<name>/" folder is created next to each source
    file, or under -o/--output (treated as a parent directory, created if
    missing) if given, preserving relative subfolder structure when
    --recursive is used.
  - If a workbook has no embedded images, no "img/" folder or "Images in
    this sheet" sections are created.

Limits:
  Each conversion may decompress at most MAX_MEMBER_UNCOMPRESSED_BYTES from
  any one zip member and MAX_TOTAL_UNCOMPRESSED_BYTES in total, and write at
  most MAX_IMAGES_PER_SHEET images per sheet and MAX_IMAGES_PER_WORKBOOK in
  total. A workbook over a limit fails before any output for it is deleted
  or written.

Exit codes:
  0 - all requested conversions succeeded
  1 - one or more conversions failed (partial success in batch mode)
  2 - required dependency ("markitdown") is not installed
  3 - invalid input (path not found, or single-file input is not .xlsx)
"""
import argparse
import io
import posixpath
import re
import shutil
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

EXIT_OK = 0
EXIT_CONVERSION_FAILED = 1
EXIT_MISSING_DEPENDENCY = 2
EXIT_INVALID_INPUT = 3

_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

# Matches MarkItDown's per-sheet heading, e.g. "## Sheet1"
_SHEET_HEADER_RE = re.compile(r"^## (.+)$", re.MULTILINE)

MAX_MEMBER_UNCOMPRESSED_BYTES = 16 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_IMAGES_PER_SHEET = 64
MAX_IMAGES_PER_WORKBOOK = 1024

# ZipExtFile.read(n) decompresses at most max(n, 4096) bytes per step for
# stored and deflated members only; bzip2 and LZMA decompress unbounded.
_READ_CHUNK_BYTES = 64 * 1024
_READABLE_COMPRESSION = (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)


class ConversionBudgetError(Exception):
    """The workbook needs more decompression or output than one conversion
    is allowed."""


class _BudgetedZip:
    """Reads members of one open ZipFile, charging their uncompressed bytes
    to a single budget shared by everything in one conversion."""

    def __init__(self, archive: zipfile.ZipFile):
        self.archive = archive
        self.names = set(archive.namelist())
        self._used = 0
        self._cache = {}

    def read(self, name: str) -> bytes:
        """Return the member's bytes, charging them again on every call so
        repeated references to one part cannot multiply work for free."""
        data = self._cache.get(name)
        if data is None:
            return self._decompress(name)
        if self._used + len(data) > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise ConversionBudgetError(
                f"reading {name} again would exceed {MAX_TOTAL_UNCOMPRESSED_BYTES} bytes in total"
            )
        self._used += len(data)
        return data

    def read_once(self, name: str) -> bytes:
        """Return the member's bytes, charging them only if not yet read."""
        data = self._cache.get(name)
        if data is None:
            return self._decompress(name)
        return data

    def _decompress(self, name: str) -> bytes:
        info = self.archive.getinfo(name)
        if info.compress_type not in _READABLE_COMPRESSION:
            raise ConversionBudgetError(
                f"{name} uses unsupported zip compression method {info.compress_type}"
            )
        if info.file_size > MAX_MEMBER_UNCOMPRESSED_BYTES:
            raise ConversionBudgetError(
                f"{name} is {info.file_size} bytes uncompressed; "
                f"the limit per part is {MAX_MEMBER_UNCOMPRESSED_BYTES}"
            )
        if self._used + info.file_size > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise ConversionBudgetError(
                f"reading {name} would decompress more than "
                f"{MAX_TOTAL_UNCOMPRESSED_BYTES} bytes in total"
            )
        chunks = []
        size = 0
        with self.archive.open(info) as member:
            while True:
                chunk = member.read(_READ_CHUNK_BYTES)
                if not chunk:
                    break
                size += len(chunk)
                if size > info.file_size:
                    raise ConversionBudgetError(f"{name} is larger than its declared size")
                chunks.append(chunk)
        self._used += size
        data = b"".join(chunks)
        self._cache[name] = data
        return data


def _import_markitdown():
    """Import MarkItDown, failing with a clear, actionable message if absent."""
    try:
        from markitdown import MarkItDown
        return MarkItDown
    except ImportError:
        print(
            "ERROR: The 'markitdown' package is not installed.\n"
            "See references/setup.md for this skill, or run:\n"
            '    pip install "markitdown[xlsx]"',
            file=sys.stderr,
        )
        sys.exit(EXIT_MISSING_DEPENDENCY)


def _normalize_rel_path(base_dir: str, target: str) -> str:
    """Resolve a (possibly relative, e.g. '../media/image1.png') relationship
    target against the directory containing the part that referenced it."""
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(base_dir, target))


def _sheet_name_to_media(xlsx_path: Path):
    """Return {sheet_name: [media_zip_path, ...]} in per-sheet document
    order, by walking workbook.xml -> worksheet -> drawing -> media
    relationships. Returns {} if anything is missing/malformed (falls back
    gracefully -- images just won't be extracted for that sheet). Raises
    ConversionBudgetError if the walk exceeds the conversion limits."""
    try:
        with zipfile.ZipFile(xlsx_path) as z:
            return _walk_sheet_media(_BudgetedZip(z))
    except (zipfile.BadZipFile, OSError):
        return {}


def _walk_sheet_media(package: _BudgetedZip):
    names = package.names
    try:
        if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
            return {}
        workbook_xml = package.read("xl/workbook.xml")
        workbook_rels_xml = package.read("xl/_rels/workbook.xml.rels")

        sheet_rid = {}
        for sheet_el in ET.fromstring(workbook_xml).iter(f"{{{_MAIN_NS}}}sheet"):
            name = sheet_el.get("name")
            rid = sheet_el.get(f"{{{_R_NS}}}id")
            if name and rid:
                sheet_rid[name] = rid

        rid_target = {}
        for rel in ET.fromstring(workbook_rels_xml).findall(f"{{{_REL_NS}}}Relationship"):
            rid_target[rel.get("Id")] = rel.get("Target")

        result = {}
        image_total = 0
        for sheet_name, rid in sheet_rid.items():
            target = rid_target.get(rid)
            if not target:
                continue
            # workbook.xml.rels targets are typically relative to "xl/",
            # but OOXML allows package-absolute targets (leading "/") too.
            sheet_path = _normalize_rel_path("xl", target)
            if sheet_path not in names or "/" not in sheet_path:
                continue
            sheet_dir, sheet_file = sheet_path.rsplit("/", 1)
            sheet_rels_path = f"{sheet_dir}/_rels/{sheet_file}.rels"
            if sheet_rels_path not in names:
                continue

            drawing_rid = None
            for d in ET.fromstring(package.read(sheet_path)).iter(f"{{{_MAIN_NS}}}drawing"):
                drawing_rid = d.get(f"{{{_R_NS}}}id")
                break
            if not drawing_rid:
                continue

            drawing_target = None
            for rel in ET.fromstring(package.read(sheet_rels_path)).findall(f"{{{_REL_NS}}}Relationship"):
                if rel.get("Id") == drawing_rid:
                    drawing_target = rel.get("Target")
                    break
            if not drawing_target:
                continue
            drawing_path = _normalize_rel_path(sheet_dir, drawing_target)
            if drawing_path not in names or "/" not in drawing_path:
                continue
            drawing_dir, drawing_file = drawing_path.rsplit("/", 1)
            drawing_rels_path = f"{drawing_dir}/_rels/{drawing_file}.rels"
            if drawing_rels_path not in names:
                continue

            drawing_rel_map = {}
            for rel in ET.fromstring(package.read(drawing_rels_path)).findall(f"{{{_REL_NS}}}Relationship"):
                drawing_rel_map[rel.get("Id")] = rel.get("Target")

            media_paths = []
            for blip in ET.fromstring(package.read(drawing_path)).iter(f"{{{_A_NS}}}blip"):
                embed_rid = blip.get(f"{{{_R_NS}}}embed")
                if not embed_rid:
                    continue
                rel_target = drawing_rel_map.get(embed_rid)
                if not rel_target:
                    continue
                media_path = _normalize_rel_path(drawing_dir, rel_target)
                if media_path in names:
                    if len(media_paths) >= MAX_IMAGES_PER_SHEET:
                        raise ConversionBudgetError(
                            f"sheet {sheet_name!r} has more than {MAX_IMAGES_PER_SHEET} images"
                        )
                    if image_total >= MAX_IMAGES_PER_WORKBOOK:
                        raise ConversionBudgetError(
                            f"workbook has more than {MAX_IMAGES_PER_WORKBOOK} images"
                        )
                    media_paths.append(media_path)
                    image_total += 1

            if media_paths:
                result[sheet_name] = media_paths
        return result
    except (zipfile.BadZipFile, KeyError, OSError, ET.ParseError):
        return {}


def _sanitize_filename_part(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("_")
    return safe or "sheet"


def _collect_images(package: _BudgetedZip, source: Path):
    """Read every embedded image within the conversion budget, before any
    output is touched. Returns {sheet_name: [(filename, bytes), ...]}."""
    collected = {}
    for sheet_idx, (sheet_name, media_paths) in enumerate(_walk_sheet_media(package).items(), start=1):
        safe_name = f"sheet{sheet_idx:03d}_{_sanitize_filename_part(sheet_name)}"
        files = []
        for idx, media_path in enumerate(media_paths, start=1):
            if media_path not in package.names:
                print(f"WARNING: {media_path} not found in {source}", file=sys.stderr)
                continue
            ext = Path(media_path).suffix.lstrip(".").lower() or "bin"
            if ext == "jpg":
                ext = "jpeg"
            files.append((f"{safe_name}_img{idx:03d}.{ext}", package.read(media_path)))
        if files:
            collected[sheet_name] = files
    return collected


def _write_images(collected, img_dir: Path):
    written = {}
    for sheet_name, files in collected.items():
        img_dir.mkdir(parents=True, exist_ok=True)
        for out_name, data in files:
            (img_dir / out_name).write_bytes(data)
        written[sheet_name] = [out_name for out_name, _ in files]
    return written


def extract_images(xlsx_path: Path, img_dir: Path):
    """Extract embedded images from xlsx_path, grouped by sheet name.
    Returns {sheet_name: [filename, ...]} in per-sheet order. Files are
    named '<sanitized_sheet_name>_img{N:03d}.<ext>'. Raises
    ConversionBudgetError, without writing anything, if the workbook
    exceeds the conversion limits."""
    try:
        archive = zipfile.ZipFile(xlsx_path)
    except (zipfile.BadZipFile, OSError):
        return {}
    with archive:
        collected = _collect_images(_BudgetedZip(archive), xlsx_path)
    return _write_images(collected, img_dir)


def insert_sheet_images(markdown_text: str, sheet_images) -> str:
    """Insert a '#### Images in this sheet' block right after each sheet's
    section (before the next '## ' heading or end of text). If a sheet has
    no images, or no '## ' headings are found at all, the text is returned
    unchanged for that part."""
    if not sheet_images:
        return markdown_text
    matches = list(_SHEET_HEADER_RE.finditer(markdown_text))
    if not matches:
        return markdown_text

    pieces = []
    last_end = 0
    for i, m in enumerate(matches):
        sheet_name = m.group(1).removesuffix("\r")
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown_text)
        pieces.append(markdown_text[last_end:start])
        section = markdown_text[start:end].rstrip("\n")
        images = sheet_images.get(sheet_name)
        if images:
            section += "\n\n#### Images in this sheet\n\n"
            section += "\n".join(f"![{name}](img/{name})" for name in images)
        pieces.append(section + "\n\n")
        last_end = end
    pieces.append(markdown_text[last_end:])
    return "".join(pieces).rstrip() + "\n"


def _table_package(package: _BudgetedZip) -> bytes:
    """Copy the XML parts into a new in-memory package for MarkItDown, so
    its table conversion only decompresses bytes this conversion already
    charged to the budget. Media and other binary parts are left out; the
    table conversion does not read them."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as out:
        for name in dict.fromkeys(info.filename for info in package.archive.infolist()):
            if name.lower().endswith((".xml", ".rels")):
                out.writestr(name, package.read_once(name))
    return buf.getvalue()


def convert_one(md, source: Path, dest_dir: Path) -> bool:
    """Convert a single .xlsx file to a '<name>/' folder containing the
    Markdown file and an 'img/' folder of extracted images. Returns True on
    success. Raises ConversionBudgetError, leaving dest_dir untouched, if
    the workbook exceeds the conversion limits."""
    from markitdown import StreamInfo

    try:
        with open(source, "rb") as fh, zipfile.ZipFile(fh) as archive:
            package = _BudgetedZip(archive)
            collected = _collect_images(package, source)
            table_bytes = _table_package(package)
    except (zipfile.BadZipFile, OSError) as exc:
        print(f"FAILED  {source} -> {exc}", file=sys.stderr)
        return False

    try:
        result = md.convert_stream(
            io.BytesIO(table_bytes),
            stream_info=StreamInfo(extension=".xlsx", filename=source.name),
        )
    except Exception as exc:  # noqa: BLE001 - surface any conversion error
        print(f"FAILED  {source} -> {exc}", file=sys.stderr)
        return False

    try:
        img_dir = dest_dir / "img"
        if dest_dir.exists():
            if img_dir.exists():
              shutil.rmtree(img_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        sheet_images = _write_images(collected, img_dir)
        text = insert_sheet_images(result.text_content, sheet_images)
        md_path = dest_dir / f"{source.stem}.md"
        md_path.write_text(text, encoding="utf-8")
    except OSError as exc:
        print(f"FAILED  {source} -> could not write output in {dest_dir}: {exc}", file=sys.stderr)
        return False

    img_count = sum(len(v) for v in sheet_images.values())
    img_note = f", {img_count} image(s)" if img_count else ""
    print(f"OK      {source} -> {md_path}{img_note}")
    return True


def _convert_reporting(md, source: Path, dest_dir: Path) -> bool:
    try:
        return convert_one(md, source, dest_dir)
    except ConversionBudgetError as exc:
        print(f"FAILED  {source} -> {exc}", file=sys.stderr)
        return False


def find_xlsx_files(root: Path, recursive: bool):
    """Return (xlsx_files, skipped_count) for files directly/recursively under root."""
    pattern_iter = root.rglob("*") if recursive else root.iterdir()
    xlsx_files = []
    skipped = 0
    for entry in pattern_iter:
        if entry.is_dir():
            continue
        if entry.suffix.lower() == ".xlsx":
            xlsx_files.append(entry)
        else:
            skipped += 1
    return sorted(xlsx_files), skipped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", help="Path to a .xlsx file or a directory of .xlsx files")
    parser.add_argument(
        "-o", "--output",
        help=(
            "Destination folder for the '<name>/' output (single-file mode), "
            "or parent directory under which each '<name>/' output folder is "
            "created (batch mode)"
        ),
    )
    parser.add_argument(
        "--recursive", action="store_true",
        help="When input is a directory, also search subdirectories",
    )
    args = parser.parse_args()

    #MarkItDown = _import_markitdown()
    #md = MarkItDown()

    source = Path(args.input)
    if not source.exists():
        print(f"ERROR: Input path not found: {source}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    if source.is_file() and source.suffix.lower() != ".xlsx":
         print(
             f"ERROR: Unsupported file type '{source.suffix}'. "
             "This skill only converts .xlsx files.",
             file=sys.stderr,
         )
         return EXIT_INVALID_INPUT

    MarkItDown = _import_markitdown()
    md = MarkItDown()

    if source.is_file():
        dest_dir = Path(args.output) if args.output else source.parent / source.stem
        return EXIT_OK if _convert_reporting(md, source, dest_dir) else EXIT_CONVERSION_FAILED

    # Directory / batch mode
    xlsx_files, skipped = find_xlsx_files(source, args.recursive)
    if skipped:
        print(f"NOTE: skipped {skipped} non-.xlsx file(s) in {source}")
    if not xlsx_files:
        print(f"ERROR: No .xlsx files found under {source}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    out_dir = Path(args.output) if args.output else None
    success_count = 0
    for xlsx_path in xlsx_files:
        if out_dir is not None:
            rel = xlsx_path.relative_to(source)
            dest_dir = out_dir / rel.parent / xlsx_path.stem
        else:
            dest_dir = xlsx_path.parent / xlsx_path.stem
        if _convert_reporting(md, xlsx_path, dest_dir):
            success_count += 1

    total = len(xlsx_files)
    print(f"\nConverted {success_count}/{total} file(s).")
    return EXIT_OK if success_count == total else EXIT_CONVERSION_FAILED


if __name__ == "__main__":
    sys.exit(main())
