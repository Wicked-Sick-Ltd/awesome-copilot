#!/usr/bin/env python3
"""Convert Word (.docx) documents to Markdown using Microsoft's MarkItDown,
with embedded images extracted to real files (MarkItDown only emits a
truncated `data:image/...;base64...` placeholder, not real image data).

Usage:
    python convert_word_to_md.py <input> [-o OUTPUT] [--recursive]

<input> may be either:
  - a path to a single .docx file, or
  - a path to a directory (batch mode: every .docx file directly inside it
    is converted; pass --recursive to also descend into subdirectories).

Output:
  For each source .docx (named "<name>.docx"), a folder is created
  containing the Markdown and its images, in this layout:

      <name>/
          img/
              img001.<ext>
              img002.<ext>
              ...
          <name>.md          (image references are relative: img/imgNNN.ext)

  - Single file mode: the "<name>/" folder is created next to the source
    file, or at -o/--output (treated as the exact destination folder) if
    given.
  - Batch/directory mode: a "<name>/" folder is created next to each source
    file, or under -o/--output (treated as a parent directory, created if
    missing) if given, preserving relative subfolder structure when
    --recursive is used.
  - If a document has no embedded images, no "img/" folder is created.

Limits:
  A document is refused, before anything is decompressed or written, when
  the .docx file is larger than 64 MiB, has more than 4096 zip members, uses
  a compression method other than stored/deflate, or would decompress to
  more than 32 MiB in total. Documents with more than 32 image references,
  or whose referenced images add up to more than 32 MiB, are refused too.

Exit codes:
  0 - all requested conversions succeeded
  1 - one or more conversions failed (partial success in batch mode)
  2 - required dependency ("markitdown") is not installed
  3 - invalid input (path not found, or single-file input is not .docx)
"""
import argparse
import io
import posixpath
import re
import shutil
import sys
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

EXIT_OK = 0
EXIT_CONVERSION_FAILED = 1
EXIT_MISSING_DEPENDENCY = 2
EXIT_INVALID_INPUT = 3

MAX_PACKAGE_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_IMAGES = 32
_READ_CHUNK = 64 * 1024
# zipfile only bounds per-call output for deflate; bzip2/lzma chunks expand
# without limit, and OPC packages may only use these two methods anyway.
_ALLOWED_COMPRESSION = (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

# MarkItDown embeds images as a literal truncated placeholder, e.g.
# ![alt](data:image/png;base64...) -- NOT real base64 data. This pattern
# matches that placeholder so it can be swapped for a real relative path.
_PLACEHOLDER_IMAGE_RE = re.compile(
    r'!\[([^\]]*)\]\(data:image/[a-zA-Z0-9.+-]+;base64[^)]*\)'
)


def _import_markitdown():
    """Import MarkItDown, failing with a clear, actionable message if absent."""
    try:
        from markitdown import MarkItDown
        return MarkItDown
    except ImportError:
        print(
            "ERROR: The 'markitdown' package is not installed.\n"
            "See references/setup.md for this skill, or run:\n"
            '    pip install "markitdown[docx]"',
            file=sys.stderr,
        )
        sys.exit(EXIT_MISSING_DEPENDENCY)


class PackageLimitError(ValueError):
    """The .docx exceeds one of the MAX_* limits and was not converted."""


def _check_archive_shape(f) -> None:
    """Refuse oversized files, and files with more central directory records
    than MAX_MEMBERS, before zipfile parses them. Every record zipfile parses
    starts with this signature, so the count bounds the ZipInfo objects it
    builds (roughly 6x the central directory size in memory)."""
    signature = b"PK\x01\x02"
    records = 0
    size = 0
    tail = b""
    while True:
        chunk = f.read(_READ_CHUNK)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_PACKAGE_BYTES:
            raise PackageLimitError(f"file is larger than {MAX_PACKAGE_BYTES} bytes")
        window = tail + chunk
        records += window.count(signature)
        tail = window[-(len(signature) - 1):]
        if records > MAX_MEMBERS:
            raise PackageLimitError(f"more than {MAX_MEMBERS} zip members")
    f.seek(0)


def _load_package(docx_path: Path) -> dict:
    """Open docx_path once and return {member_name: bytes} for every file
    member. Sizes declared in the central directory are checked before
    anything is decompressed, and members are then decompressed in bounded
    chunks against the same limits, because a declared size can lie and
    ZipFile.read() would inflate up to 2 GiB of a lying deflate member in a
    single call. Everything downstream works from the returned members, never
    from docx_path again."""
    with open(docx_path, "rb") as f:
        _check_archive_shape(f)
        return _read_members(f)


def _read_members(f) -> dict:
    members = {}
    try:
        with zipfile.ZipFile(f) as z:
            infos = z.infolist()
            seen = set()
            declared_total = 0
            for info in infos:
                if info.filename in seen:
                    raise PackageLimitError(f"duplicate zip member {info.filename!r}")
                seen.add(info.filename)
                if info.flag_bits & 0x1:
                    raise PackageLimitError(f"zip member {info.filename!r} is encrypted")
                if info.compress_type not in _ALLOWED_COMPRESSION:
                    raise PackageLimitError(
                        f"zip member {info.filename!r} uses unsupported "
                        f"compression method {info.compress_type}"
                    )
                if info.file_size > MAX_MEMBER_BYTES:
                    raise PackageLimitError(
                        f"zip member {info.filename!r} would decompress to "
                        f"{info.file_size} bytes (limit {MAX_MEMBER_BYTES})"
                    )
                declared_total += info.file_size
                if declared_total > MAX_TOTAL_BYTES:
                    raise PackageLimitError(
                        f"package would decompress to more than {MAX_TOTAL_BYTES} bytes"
                    )

            total = 0
            for info in infos:
                if info.is_dir():
                    continue
                chunks = []
                size = 0
                with z.open(info) as member:
                    while True:
                        chunk = member.read(_READ_CHUNK)
                        if not chunk:
                            break
                        size += len(chunk)
                        total += len(chunk)
                        if size > MAX_MEMBER_BYTES or total > MAX_TOTAL_BYTES:
                            raise PackageLimitError(
                                f"zip member {info.filename!r} decompressed past the size limit"
                            )
                        chunks.append(chunk)
                members[info.filename] = b"".join(chunks)
    except (EOFError, zlib.error, RuntimeError, NotImplementedError) as exc:
        raise zipfile.BadZipFile(str(exc)) from exc
    return members


def _members_of(docx):
    """Accept a .docx path, or members already returned by _load_package."""
    if isinstance(docx, dict):
        return docx
    return _load_package(Path(docx))


def _package_stream(members) -> io.BytesIO:
    """Re-pack validated members into a fresh archive whose declared sizes
    are the real ones, so MarkItDown's own full-member reads stay bounded."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    buf.seek(0)
    return buf


def _parse_xml(data):
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        return None


def _relationship_targets(members, part: str) -> dict:
    directory, name = posixpath.split(part)
    rels_root = _parse_xml(members.get(posixpath.join(directory, "_rels", name + ".rels"), b""))
    if rels_root is None:
        return {}
    return {
        rel.get("Id"): rel.get("Target")
        for rel in rels_root.findall(f"{{{_REL_NS}}}Relationship")
    }


def _image_rel_ids(root):
    for elem in root.iter():
        tag = elem.tag.rsplit("}", 1)[-1]
        if tag == "blip":
            yield elem.get(f"{{{_R_NS}}}embed") or elem.get(f"{{{_R_NS}}}link")
        elif tag == "imagedata":
            yield elem.get(f"{{{_R_NS}}}id")


def _media_zip_path(target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(
        target if target.startswith("word/") else posixpath.join("word", target)
    )


def _check_image_budget(members) -> None:
    """Refuse packages whose image references, in any XML part, exceed
    MAX_IMAGES or add up to more than MAX_TOTAL_BYTES. MarkItDown (via
    mammoth) reads and base64-encodes an image once per reference, so one
    member referenced many times is charged every time."""
    count = 0
    total = 0
    for part, data in members.items():
        if not part.lower().endswith(".xml"):
            continue
        root = _parse_xml(data)
        if root is None:
            continue
        rels = None
        for rid in _image_rel_ids(root):
            if not rid:
                continue
            if rels is None:
                rels = _relationship_targets(members, part)
            target = rels.get(rid)
            if not target:
                continue
            # mammoth resolves targets as "word/" + target; this script
            # normalizes them. Charge whichever names the larger member.
            mammoth_name = target[1:] if target.startswith("/") else "word/" + target
            sizes = [
                len(members[name])
                for name in (mammoth_name, _media_zip_path(target))
                if name in members
            ]
            if not sizes:
                continue
            count += 1
            total += max(sizes)
            if count > MAX_IMAGES:
                raise PackageLimitError(f"more than {MAX_IMAGES} image references")
            if total > MAX_TOTAL_BYTES:
                raise PackageLimitError(
                    f"referenced images add up to more than {MAX_TOTAL_BYTES} bytes"
                )


def _document_order_media(docx):
    """Return [(rel_id, media_zip_path), ...] in the order images appear in
    word/document.xml (via r:embed / r:id), resolved through
    word/_rels/document.xml.rels. docx is a path or the members returned by
    _load_package. Returns [] if the document has no body part or no images
    (e.g. malformed docx falls back gracefully); raises PackageLimitError if
    the package exceeds the MAX_* limits."""
    try:
        members = _members_of(docx)
    except (zipfile.BadZipFile, OSError):
        return []
    rels_xml = members.get("word/_rels/document.xml.rels")
    doc_xml = members.get("word/document.xml")
    if rels_xml is None or doc_xml is None:
        return []

    rels_root = _parse_xml(rels_xml)
    doc_root = _parse_xml(doc_xml)
    if rels_root is None or doc_root is None:
        return []

    rel_map = {}
    for rel in rels_root.findall(f"{{{_REL_NS}}}Relationship"):
        rel_map[rel.get("Id")] = rel.get("Target")

    ordered_rel_ids = []
    for elem in doc_root.iter():
        tag = elem.tag.rsplit("}", 1)[-1]
        if tag == "blip":
            rid = elem.get(f"{{{_R_NS}}}embed")
        elif tag == "imagedata":
            rid = elem.get(f"{{{_R_NS}}}id")
        else:
            rid = None
        if rid:
            ordered_rel_ids.append(rid)
    ordered_media = []
    for rid in ordered_rel_ids:
        target = rel_map.get(rid)
        if not target or "media/" not in target:
            continue
        ordered_media.append((rid, _media_zip_path(target)))
    return ordered_media


def _plan_images(members, label: str):
    """Return [(out_name, data), ...] for the images to write, in document
    order, raising PackageLimitError before anything is written if there are
    more than MAX_IMAGES or they add up to more than MAX_TOTAL_BYTES."""
    planned = []
    total = 0
    for idx, (rid, media_path) in enumerate(_document_order_media(members), start=1):
        data = members.get(media_path)
        if data is None:
            print(f"WARNING: {media_path} (rel {rid}) not found in {label}", file=sys.stderr)
            continue
        ext = Path(media_path).suffix.lstrip(".").lower() or "bin"
        if ext == "jpg":
            ext = "jpeg"
        planned.append((f"img{idx:03d}.{ext}", data))
        total += len(data)
        if len(planned) > MAX_IMAGES:
            raise PackageLimitError(f"more than {MAX_IMAGES} images to extract")
        if total > MAX_TOTAL_BYTES:
            raise PackageLimitError(f"images add up to more than {MAX_TOTAL_BYTES} bytes")
    return planned


def _write_images(planned, img_dir: Path):
    written = []
    for out_name, data in planned:
        img_dir.mkdir(parents=True, exist_ok=True)
        (img_dir / out_name).write_bytes(data)
        written.append(out_name)
    return written


def _extract_images(docx_path: Path, img_dir: Path):
    """Extract embedded images from docx_path into img_dir as img001.ext,
    img002.ext, ... in document order. Returns the list of written filenames
    (relative to img_dir), in that same order. Raises PackageLimitError,
    without creating img_dir, if the package or its images exceed the MAX_*
    limits."""
    try:
        members = _load_package(Path(docx_path))
    except (zipfile.BadZipFile, OSError):
        return []
    return _write_images(_plan_images(members, str(docx_path)), img_dir)


def _rewrite_image_refs(markdown_text: str, image_files) -> str:
    """Replace MarkItDown's truncated base64 image placeholders with real
    relative img/imgNNN.ext references, in left-to-right order. If the
    counts don't match (unexpected), the placeholders are left as-is rather
    than risk mismatched references."""
    matches = list(_PLACEHOLDER_IMAGE_RE.finditer(markdown_text))
    if not matches:
        return markdown_text
    if len(matches) != len(image_files):
        print(
            f"WARNING: found {len(matches)} image placeholder(s) in markdown but "
            f"extracted {len(image_files)} image file(s); leaving placeholders "
            "unreplaced to avoid mismatched references.",
            file=sys.stderr,
        )
        return markdown_text

    counter = {"i": 0}

    def _replace(m):
        name = image_files[counter["i"]]
        counter["i"] += 1
        return f"![{m.group(1)}](img/{name})"

    return _PLACEHOLDER_IMAGE_RE.sub(_replace, markdown_text)


def convert_one(md, source: Path, dest_dir: Path) -> bool:
    """Convert a single .docx file to a "<name>/" folder containing the
    Markdown file and an "img/" folder of extracted images. Returns True on
    success."""
    try:
        members = _load_package(source)
        _check_image_budget(members)
        planned_images = _plan_images(members, str(source))
    except PackageLimitError as exc:
        print(f"FAILED  {source} -> refused: {exc}", file=sys.stderr)
        return False
    except (zipfile.BadZipFile, OSError) as exc:
        print(f"FAILED  {source} -> {exc}", file=sys.stderr)
        return False

    try:
      from markitdown import StreamInfo
      result = md.convert_stream(
          _package_stream(members),
          stream_info=StreamInfo(extension=".docx", filename=source.name),
      )
    except ImportError as exc:
      print(
        f"ERROR: A required dependency for converting '{source.name}' is not installed.\n"
        f"  {exc}\n"
        "See references/setup.md for this skill, or run:\n"
        '    pip install "markitdown[docx]"',
        file=sys.stderr,
      )
      sys.exit(EXIT_MISSING_DEPENDENCY)
    except Exception as exc:  # noqa: BLE001 - surface any conversion error
        print(f"FAILED  {source} -> {exc}", file=sys.stderr)
        return False

    try:
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        image_files = _write_images(planned_images, dest_dir / "img")
        text = _rewrite_image_refs(result.text_content, image_files)
        md_path = dest_dir / f"{source.stem}.md"
        md_path.write_text(text, encoding="utf-8")
    except OSError as exc:
        print(f"FAILED  {source} -> could not write output in {dest_dir}: {exc}", file=sys.stderr)
        return False

    img_note = f", {len(image_files)} image(s)" if image_files else ""
    print(f"OK      {source} -> {md_path}{img_note}")
    return True


def find_docx_files(root: Path, recursive: bool):
    """Return (docx_files, skipped_count) for files directly/recursively under root."""
    pattern_iter = root.rglob("*") if recursive else root.iterdir()
    docx_files = []
    skipped = 0
    for entry in pattern_iter:
        if entry.is_dir():
            continue
        if entry.suffix.lower() == ".docx":
            docx_files.append(entry)
        else:
            skipped += 1
    return sorted(docx_files), skipped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", help="Path to a .docx file or a directory of .docx files")
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

    if source.is_file() and source.suffix.lower() != ".docx":
         print(
             f"ERROR: Unsupported file type '{source.suffix}'. "
             "This skill only converts .docx files.",
             file=sys.stderr,
         )
         return EXIT_INVALID_INPUT

    MarkItDown = _import_markitdown()
    md = MarkItDown()

    if source.is_file():
        dest_dir = Path(args.output) if args.output else source.parent / source.stem
        return EXIT_OK if convert_one(md, source, dest_dir) else EXIT_CONVERSION_FAILED

    # Directory / batch mode
    docx_files, skipped = find_docx_files(source, args.recursive)
    if skipped:
        print(f"NOTE: skipped {skipped} non-.docx file(s) in {source}")
    if not docx_files:
        print(f"ERROR: No .docx files found under {source}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    out_dir = Path(args.output) if args.output else None
    success_count = 0
    for docx_path in docx_files:
        if out_dir is not None:
            rel = docx_path.relative_to(source)
            dest_dir = out_dir / rel.parent / docx_path.stem
        else:
            dest_dir = docx_path.parent / docx_path.stem
        if convert_one(md, docx_path, dest_dir):
            success_count += 1

    total = len(docx_files)
    print(f"\nConverted {success_count}/{total} file(s).")
    return EXIT_OK if success_count == total else EXIT_CONVERSION_FAILED


if __name__ == "__main__":
    sys.exit(main())
