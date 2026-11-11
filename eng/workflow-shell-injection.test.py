"""Regression: untrusted GitHub context must not be interpolated inside run:."""

import pathlib
import re
import unittest


# Contexts Semgrep run-shell-injection treats as attacker-controlled when
# they appear inside a run: script. Numbers and runner-controlled values
# such as github.run_id are not in this list.
UNTRUSTED_CONTEXTS = (
    "github.base_ref",
    "github.head_ref",
    "github.ref_name",
    "github.ref",
    "github.event.issue.title",
    "github.event.issue.body",
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.pull_request.head.ref",
    "github.event.pull_request.head.label",
    "github.event.comment.body",
    "github.event.review.body",
    "github.event.review_comment.body",
    "github.event.head_commit.message",
    "github.event.head_commit.author.email",
    "github.event.head_commit.author.name",
    "github.event.discussion.title",
    "github.event.discussion.body",
    "github.event.inputs",
    "github.event.workflow_run.head_branch",
    "github.event.workflow_run.head_commit.message",
)

ROOT = pathlib.Path(__file__).parents[1]


def run_scripts(text):
    """Yield the shell body of each run: step."""
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)(?:-\s*)?run:\s*(.*)$", lines[index])
        if not match:
            index += 1
            continue
        indent = lines[index].index("run:")
        rest = match.group(2).strip()
        # `run: | # note` is a block header; the comment is not the script.
        header = re.sub(r"\s+#.*$", "", rest).strip()
        if header in {"|", ">", "|-", ">-", "|+", ">+"}:
            index += 1
            body = []
            while index < len(lines):
                nxt = lines[index]
                if nxt.strip() == "":
                    body.append(nxt)
                    index += 1
                    continue
                next_indent = len(nxt) - len(nxt.lstrip(" "))
                if next_indent <= indent:
                    break
                body.append(nxt)
                index += 1
            yield "\n".join(body)
            continue
        yield rest
        index += 1


def untrusted_hits(script):
    hits = []
    for context in UNTRUSTED_CONTEXTS:
        if re.search(r"\$\{\{\s*" + re.escape(context) + r"\b", script):
            hits.append(context)
    return hits


class WorkflowShellInjectionTests(unittest.TestCase):
    def test_sample_run_block_is_detected(self):
        sample = "run: |\n  git diff origin/${{ github.base_ref }}...HEAD\n"
        scripts = list(run_scripts(sample))
        self.assertEqual(untrusted_hits(scripts[0]), ["github.base_ref"])

    def test_list_item_run_is_scanned(self):
        sample = '- run: echo "${{ github.base_ref }}"\n'
        scripts = list(run_scripts(sample))
        self.assertEqual(untrusted_hits(scripts[0]), ["github.base_ref"])

    def test_block_header_comment_does_not_hide_the_script(self):
        sample = "run: | # comment\n  echo \"${{ github.head_ref }}\"\n"
        scripts = list(run_scripts(sample))
        self.assertEqual(untrusted_hits(scripts[0]), ["github.head_ref"])

    def test_sibling_env_is_not_part_of_the_script(self):
        sample = (
            "- run: |\n"
            '    echo "$BASE_REF"\n'
            "  env:\n"
            "    BASE_REF: ${{ github.base_ref }}\n"
        )
        scripts = list(run_scripts(sample))
        self.assertEqual(untrusted_hits(scripts[0]), [])
        self.assertNotIn("github.base_ref", scripts[0])

    def test_env_indirection_is_not_a_hit(self):
        sample = "env:\n  BASE_REF: ${{ github.base_ref }}\nrun: |\n  git diff \"origin/${BASE_REF}...HEAD\"\n"
        scripts = list(run_scripts(sample))
        self.assertEqual(scripts, ['  git diff "origin/${BASE_REF}...HEAD"'])
        self.assertEqual(untrusted_hits(scripts[0]), [])

    def test_workflow_run_scripts_have_no_untrusted_interpolation(self):
        failures = []
        for path in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            for script in run_scripts(path.read_text(encoding="utf-8")):
                hits = untrusted_hits(script)
                if hits:
                    failures.append(f"{path.relative_to(ROOT)}: {', '.join(hits)}")
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
