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
  - The "<name>/" destination folder must not already exist. If anything is
    already at that path (an earlier conversion or any unrelated folder),
    that file is reported as failed and the existing path is left untouched;
    it is never deleted, replaced, or written into.
  - If a document has no embedded images, no "img/" folder is created.

Exit codes:
  0 - all requested conversions succeeded
  1 - one or more conversions failed (partial success in batch mode),
      including a destination folder that already exists
  2 - required dependency ("markitdown") is not installed
  3 - invalid input (path not found, or single-file input is not .docx)
"""
import argparse
import errno
import os
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

_DIR_FD_SUPPORTED = (
    os.open in os.supports_dir_fd
    and os.mkdir in os.supports_dir_fd
    and os.listdir in os.supports_fd
    and hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
)


class OutputDir:
    """A directory created by this script for one conversion.

    Output never replaces or removes anything that already exists: the
    directory itself and every entry in it are created exclusively. Where the
    platform supports it, writes go through a descriptor for the directory
    that was created and checked empty, so a path swapped in afterwards is
    never written to."""

    def __init__(self, path: Path, fd=None):
        self.path = path
        self._fd = fd

    @classmethod
    def create(cls, path: Path) -> "OutputDir":
        """Create `path` as a new directory. Raises FileExistsError if
        anything is already there."""
        path.parent.mkdir(parents=True, exist_ok=True)
        if not _DIR_FD_SUPPORTED:
            os.mkdir(path)
            return cls(path)
        parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            return cls._create_at(parent_fd, path.name, path)
        finally:
            os.close(parent_fd)

    @classmethod
    def _create_at(cls, parent_fd, name: str, path: Path) -> "OutputDir":
        os.mkdir(name, dir_fd=parent_fd)
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        if os.listdir(fd):
            os.close(fd)
            raise FileExistsError(errno.EEXIST, "directory changed after it was created", str(path))
        return cls(path, fd)

    def mkdir(self, name: str) -> "OutputDir":
        if self._fd is None:
            os.mkdir(self.path / name)
            return OutputDir(self.path / name)
        return OutputDir._create_at(self._fd, name, self.path / name)

    def _open_new(self, name: str, mode: str, **kwargs):
        if self._fd is None:
            return open(self.path / name, mode.replace("w", "x"), **kwargs)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        fd = os.open(name, flags, 0o666, dir_fd=self._fd)
        try:
            return os.fdopen(fd, mode, **kwargs)
        except BaseException:
            os.close(fd)
            raise

    def write_bytes(self, name: str, data: bytes) -> None:
        with self._open_new(name, "wb") as handle:
            handle.write(data)

    def write_text(self, name: str, text: str) -> None:
        with self._open_new(name, "w", encoding="utf-8") as handle:
            handle.write(text)

    def close(self) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()

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


def _document_order_media(docx_path: Path):
    """Return [(rel_id, media_zip_path), ...] in the order images appear in
    word/document.xml (via r:embed / r:id), resolved through
    word/_rels/document.xml.rels. Returns [] if the document has no body
    part or no images (e.g. malformed docx falls back gracefully)."""
    try:
        with zipfile.ZipFile(docx_path) as z:
            if "word/document.xml" not in z.namelist() or \
               "word/_rels/document.xml.rels" not in z.namelist():
                return []
            rels_xml = z.read("word/_rels/document.xml.rels")
            doc_xml = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError, OSError):
        return []

    try:
         rels_root = ET.fromstring(rels_xml)
         doc_root = ET.fromstring(doc_xml)
    except ET.ParseError:
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
        import posixpath
        media_path = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(
                 target if target.startswith("word/") else posixpath.join("word", target)
             )
        )
        ordered_media.append((rid, media_path))
    return ordered_media


def _extract_images(docx_path: Path, out: OutputDir):
    """Extract embedded images from docx_path into a new 'img/' folder inside
    `out` (created only if there is at least one image) as img001.ext,
    img002.ext, ... in document order. Returns the list of written filenames
    (relative to img/), in that same order."""
    ordered_media = _document_order_media(docx_path)
    if not ordered_media:
        return []

    written = []
    img_dir = None
    try:
        with zipfile.ZipFile(docx_path) as z:
            names_in_zip = set(z.namelist())
            for idx, (rid, media_path) in enumerate(ordered_media, start=1):
                if media_path not in names_in_zip:
                    print(f"WARNING: {media_path} (rel {rid}) not found in {docx_path}", file=sys.stderr)
                    continue
                ext = Path(media_path).suffix.lstrip(".").lower() or "bin"
                if ext == "jpg":
                    ext = "jpeg"
                out_name = f"img{idx:03d}.{ext}"
                if img_dir is None:
                    img_dir = out.mkdir("img")
                img_dir.write_bytes(out_name, z.read(media_path))
                written.append(out_name)
    finally:
        if img_dir is not None:
            img_dir.close()
    return written


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
    """Convert a single .docx file to a new "<name>/" folder containing the
    Markdown file and an "img/" folder of extracted images. Refuses if
    anything already exists at dest_dir. Returns True on success."""
    try:
      result = md.convert(str(source))
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
        out = OutputDir.create(dest_dir)
    except FileExistsError:
        print(
            f"FAILED  {source} -> {dest_dir} already exists; refusing to replace it. "
            "Remove or rename it yourself, or choose a new destination with -o.",
            file=sys.stderr,
        )
        return False
    except OSError as exc:
        print(f"FAILED  {source} -> could not create {dest_dir}: {exc}", file=sys.stderr)
        return False

    try:
        with out:
            image_files = _extract_images(source, out)
            text = _rewrite_image_refs(result.text_content, image_files)
            md_name = f"{source.stem}.md"
            out.write_text(md_name, text)
            md_path = dest_dir / md_name
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
