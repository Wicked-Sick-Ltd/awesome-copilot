"""Report comments must not close the tuning report's script element.

The Geofeed Tuner skill stores each original CSV comment line in the comment
map and tells the agent to insert that map with the Python block in SKILL.md
that assigns ``comments_json`` and replaces ``{{.Comments}}``. The template
places that replacement in ``scripts/templates/index.html`` at
``const commentMap = {{.Comments}}``, inside a classic script. These tests
follow that path: a feed is reduced to the comment map the skill specifies,
the published block is executed against the real template, and Chrome parses
the report.

They fail while that block emits a raw less-than character. A comment that
contains a script end tag then ends the report script, and the markup that
follows it runs with the report page. A fix passes when every stored comment,
including that line, is still readable as ``commentMap`` data and the marker
in the comment does not run.

The same insertion is described again in the Phase 5 output guarantees. There
is not a second sink. ``{{.Metadata.Timestamp}}`` is also inside a script, but
the skill fills it with the agent's own clock value, not with feed text, so
these tests do not cover it.
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = SKILL_ROOT / "scripts" / "templates" / "index.html"
SKILL = SKILL_ROOT / "SKILL.md"

# Single quotes only. json.dumps escapes double quotes, and those backslashes
# would sit in the injected script source and hide a real breakout.
MARKER = (
    "document.title='rewritten-by-comment';"
    "document.documentElement.setAttribute('data-attacker','RAN')"
)
BENIGN = "# It's OK for small city states to leave state ISO2 code unspecified"
DATA_ROW = "203.0.113.0/24,US,US-CA,Example,"


def comments_from_feed(feed: str) -> dict[str, str]:
    """Build the Phase 2 comment map from a feed.

    The skill stores the full original line, keyed by its 1-based line
    number, when the first CSV column begins with '#'. Blank lines are
    stored as well.
    """
    comments: dict[str, str] = {}
    for index, line in enumerate(feed.splitlines(), start=1):
        if line == "":
            comments[str(index)] = line
            continue
        row = next(csv.reader([line]))
        if row and row[0].startswith("#"):
            comments[str(index)] = line
    return comments


def published_embedding_snippet() -> str:
    """Return the SKILL.md Python block that inserts the comment map."""
    skill = SKILL.read_text(encoding="utf-8")
    fence = "```python\n"
    blocks: list[str] = []
    start = 0
    while True:
        begin = skill.find(fence, start)
        if begin < 0:
            break
        body_at = begin + len(fence)
        end = skill.find("\n```", body_at)
        if end < 0:
            break
        block = skill[body_at:end]
        if "comments_json" in block and "{{.Comments}}" in block:
            blocks.append(block)
        start = end + 4
    if len(blocks) != 1:
        raise AssertionError(
            f"expected one comment-map embedding block in SKILL.md, found {len(blocks)}"
        )
    return blocks[0]


def embed_comments(comments: dict[str, str]) -> str:
    """Run the skill's published embedding block against the real template."""
    template = TEMPLATE.read_text(encoding="utf-8")
    if "const commentMap = {{.Comments}};" not in template:
        raise AssertionError("template is missing the commentMap script assignment")
    namespace = {"json": json, "comments": comments, "template": template}
    exec(compile(published_embedding_snippet(), str(SKILL), "exec"), namespace, namespace)
    rendered = namespace["template"]
    if "{{.Comments}}" in rendered:
        raise AssertionError("embedding block left {{.Comments}} in the report")
    return rendered


def js_literal(value: object) -> str:
    """Embed a probe value without introducing a script end tag."""
    dumped = json.dumps(value, ensure_ascii=True)
    return (
        dumped.replace("<", r"\u003c")
        .replace(">", r"\u003e")
        .replace("&", r"\u0026")
        .replace("\u2028", r"\u2028")
        .replace("\u2029", r"\u2029")
    )


def with_probe(report: str, comments: dict[str, str]) -> str:
    probe = (
        "<script>"
        "var expected = "
        + js_literal(comments)
        + ";"
        "var ok = typeof commentMap !== 'undefined' && commentMap !== null;"
        "if (ok && Object.keys(commentMap).length !== Object.keys(expected).length) ok = false;"
        "if (ok) { Object.keys(expected).forEach(function (key) {"
        "if (commentMap[key] !== expected[key]) ok = false;"
        "}); }"
        "document.documentElement.setAttribute('data-preserved', ok ? 'yes' : 'no');"
        "</script>"
    )
    if "</body>" not in report:
        raise AssertionError("template has no </body>")
    return report.replace("</body>", probe + "</body>", 1)


def chrome_binary() -> str:
    for candidate in ("/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            # The /usr/local/bin/google-chrome wrapper forces a shared profile
            # and a debugging port, and dump-dom never returns under it.
            if candidate != "/usr/local/bin/google-chrome":
                return candidate
    found = shutil.which("google-chrome-stable") or shutil.which("google-chrome")
    if found and os.path.basename(found) != "google-chrome":
        return found
    if found and os.path.realpath(found).endswith("/chrome"):
        return os.path.realpath(found)
    raise AssertionError("headless Chrome is required to parse the generated report")


def open_report(report: str) -> str:
    with tempfile.TemporaryDirectory(prefix="geofeed-report-") as temp:
        root = Path(temp)
        html_path = root / "geofeed-report.html"
        html_path.write_text(report, encoding="utf-8")
        profile = root / "chrome-profile"
        completed = subprocess.run(
            [
                chrome_binary(),
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                f"--user-data-dir={profile}",
                "--virtual-time-budget=2000",
                "--dump-dom",
                html_path.as_uri(),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0 or "<html" not in completed.stdout:
            raise AssertionError(
                "Chrome did not return a document: "
                + " ".join(completed.stderr.split())[-400:]
            )
        return completed.stdout


def report_signals(dom: str) -> dict[str, str]:
    root_at = dom.find("<html")
    root_end = dom.find(">", root_at)
    title_at = dom.find("<title>")
    title_end = dom.find("</title>", title_at)
    return {
        "root": dom[root_at:root_end + 1],
        "title": dom[title_at:title_end],
    }


def feed_with(comment_line: str) -> str:
    return "\n".join([BENIGN, "", DATA_ROW, comment_line]) + "\n"


class CommentMapScriptEmbeddingTest(unittest.TestCase):
    def assert_report_inert(self, feed: str) -> None:
        comments = comments_from_feed(feed)
        report = with_probe(embed_comments(comments), comments)
        signals = report_signals(open_report(report))
        self.assertEqual(
            signals,
            {
                "root": '<html lang="en" data-preserved="yes">',
                "title": "<title>Geofeed Tuner Report",
            },
            signals,
        )

    def test_benign_comment_and_blank_line_round_trip(self) -> None:
        feed = "\n".join([BENIGN, "", DATA_ROW]) + "\n"
        comments = comments_from_feed(feed)
        self.assertEqual(comments, {"1": BENIGN, "2": ""})
        self.assert_report_inert(feed)

    def test_script_end_tag_in_comment_does_not_run(self) -> None:
        cases = {
            "exact": f"# note, keep this </script><script>{MARKER}</script>",
            "upper": f"# note, keep this </SCRIPT><script>{MARKER}</script>",
            "mixed": f"# note, keep this </ScRiPt><script>{MARKER}</script>",
            "space": f"# note, keep this </script ><script>{MARKER}</script>",
            "two-spaces": f"# note, keep this </script  ><script>{MARKER}</script>",
            "solidus": f"# note, keep this </script/><script>{MARKER}</script>",
            "solidus-spaces": f"# note, keep this </script / ><script>{MARKER}</script>",
            "svg-onload": f"# note, keep this </script><svg/onload={MARKER}>",
            "quoted-field": (
                '"# note, keep this </script><script>' + MARKER + '</script>"'
            ),
        }
        for name, comment_line_text in cases.items():
            with self.subTest(name=name):
                feed = feed_with(comment_line_text)
                comments = comments_from_feed(feed)
                self.assertEqual(comments["4"], comment_line_text)
                self.assertEqual(comments["1"], BENIGN)
                self.assertEqual(comments["2"], "")
                self.assertNotIn("3", comments)
                self.assert_report_inert(feed)


if __name__ == "__main__":
    unittest.main()
