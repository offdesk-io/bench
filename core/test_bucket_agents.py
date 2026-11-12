#!/usr/bin/env python3
"""python3 core/test_bucket_agents.py

Over a throwaway data root only: no real list is read or written."""

import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bucket_agents  # noqa: E402


def template():
    with open(bucket_agents.TEMPLATE, encoding="utf-8") as fh:
        return fh.read()


FILLED = {
    "What this agent is for": "Drafts the weekly newsletter and leaves sending to me.",
    "The processes I run in this bucket": "**Newsletter.** Every Friday. Produces a draft in `drafts/`.",
    "Guidelines it follows": "British English, under 300 words.",
    "What it may touch": "`drafts/` and the newsletter board.",
    "What it must never touch": "The mailing list itself. Nothing is ever sent.",
    "What good looks like here": "A draft I send with one edit at most.",
}


def filled(mode="plan-first", start=None, drop=None, marker=False):
    """The template with every required section written and the marker gone,
    `mode` and `start` set (None leaves the key out), and the section named
    `drop` left as the template has it."""
    text = template()
    front = "---\n" + ("mode: %s\n" % mode if mode is not None else "")
    front += "start: %s\n" % start if start is not None else ""
    front += "---\n"
    text = front + text.split("---\n", 2)[2]
    if not marker:
        text = text.replace(bucket_agents.NOT_FILLED + "\n", "")
    for heading, body in FILLED.items():
        if heading != drop:
            text = text.replace("## %s\n\n" % heading, "## %s\n\n%s\n\n" % (heading, body))
    return text


class BucketAgentsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, "demo"))
        with open(os.path.join(self.root, "demo", "todo.md"), "w", encoding="utf-8") as fh:
            fh.write("# To-do\n")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, bucket, text):
        folder = os.path.join(self.root, "demo", "buckets", bucket)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "%s.md" % bucket), "w", encoding="utf-8") as fh:
            fh.write(text)

    def load(self, bucket):
        return bucket_agents.load("demo", bucket, self.root)

    def test_template_unfilled_is_not_ready(self):
        self.write("news", template())
        got = self.load("news")
        self.assertFalse(got["ready"])
        self.assertEqual(got["missing"], ["marker", "mode"] + list(bucket_agents.REQUIRED))
        self.assertEqual(got["fields"]["purpose"], "")
        self.assertEqual(got["start"], "on-assign")

    def test_marker_alone_keeps_it_not_ready(self):
        self.write("news", filled(marker=True))
        got = self.load("news")
        self.assertFalse(got["ready"])
        self.assertEqual(got["missing"], ["marker"])

    def test_filled_plan_first_is_ready(self):
        self.write("news", filled("plan-first"))
        got = self.load("news")
        self.assertTrue(got["ready"], got["missing"])
        self.assertEqual(got["missing"], [])
        self.assertEqual(got["mode"], "plan-first")
        self.assertEqual(got["fields"]["guidelines"], "British English, under 300 words.")
        self.assertEqual(got["fields"]["involved"], "")

    def test_template_guidance_kept_under_written_text_is_dropped(self):
        self.write("news", filled())
        got = self.load("news")
        self.assertEqual(got["fields"]["purpose"],
                         "Drafts the weekly newsletter and leaves sending to me.")

    def test_free_rein_is_ready(self):
        self.write("news", filled("free-rein", start="scheduled"))
        got = self.load("news")
        self.assertTrue(got["ready"], got["missing"])
        self.assertEqual((got["mode"], got["start"]), ("free-rein", "scheduled"))

    def test_missing_mode(self):
        self.write("news", filled(mode=None))
        got = self.load("news")
        self.assertFalse(got["ready"])
        self.assertEqual(got["missing"], ["mode"])
        self.assertIsNone(got["mode"])

    def test_no_frontmatter_is_missing_mode(self):
        self.write("news", filled().split("---\n", 2)[2])
        self.assertEqual(self.load("news")["missing"], ["mode"])

    def test_bad_mode(self):
        self.write("news", filled(mode="whenever"))
        got = self.load("news")
        self.assertFalse(got["ready"])
        self.assertEqual(got["missing"], ["mode"])
        self.assertIsNone(got["mode"])

    def test_mode_with_quotes_and_comment(self):
        self.write("news", filled(mode='"free-rein"  # or plan-first'))
        self.assertEqual(self.load("news")["mode"], "free-rein")

    def test_bad_start(self):
        self.write("news", filled(start="sometimes"))
        got = self.load("news")
        self.assertEqual(got["missing"], ["start"])
        self.assertIsNone(got["start"])

    def test_empty_section(self):
        self.write("news", filled(drop="What it must never touch"))
        got = self.load("news")
        self.assertFalse(got["ready"])
        self.assertEqual(got["missing"], ["never_touch"])

    def test_placeholder_only_section_is_empty(self):
        text = filled().replace("A draft I send with one edit at most.", "<Fill this in.>")
        self.write("news", text)
        self.assertEqual(self.load("news")["missing"], ["good"])

    def test_section_heading_gone_is_empty(self):
        text = filled().replace("## Guidelines it follows", "## Something else")
        self.write("news", text)
        self.assertEqual(self.load("news")["missing"], ["guidelines"])

    def test_start_defaults_to_on_assign(self):
        self.write("news", filled(start=None))
        got = self.load("news")
        self.assertTrue(got["ready"])
        self.assertEqual(got["start"], "on-assign")

    def test_old_brief_is_not_ready(self):
        self.write("news", "# News\n\nWhat lands here.\n\n## The processes I run in this bucket\n\n"
                           "**Newsletter.** Fridays.\n\n## What good looks like here\n\nShort.\n")
        got = self.load("news")
        self.assertEqual(got["missing"], ["mode", "purpose", "guidelines", "may_touch", "never_touch"])
        self.assertEqual(got["fields"]["processes"], "**Newsletter.** Fridays.")

    def test_bucket_with_no_file(self):
        os.makedirs(os.path.join(self.root, "demo", "buckets", "admin"))
        got = self.load("admin")
        self.assertFalse(got["exists"])
        self.assertFalse(got["ready"])
        self.assertEqual(got["missing"], ["mode"] + list(bucket_agents.REQUIRED))
        self.assertEqual(got["path"], os.path.join(self.root, "demo", "buckets", "admin", "admin.md"))

    def test_all_buckets_readme_order_then_folders(self):
        self.write("news", filled())
        self.write("admin", template())
        os.makedirs(os.path.join(self.root, "demo", "buckets", "zeta"))
        with open(os.path.join(self.root, "demo", "buckets", "README.md"), "w", encoding="utf-8") as fh:
            fh.write("| Heading in `todo.md` | Stream | Brief |\n| --- | --- | --- |\n"
                     "| `## 2. News` | `news` | `news/news.md` |\n"
                     "| `## 1. Planned` | `planned` | `planned/planned.md` |\n")
        got = bucket_agents.all_buckets("demo", self.root)
        self.assertEqual([r["bucket"] for r in got], ["news", "planned", "admin", "zeta"])
        self.assertEqual([r["ready"] for r in got], [True, False, False, False])
        self.assertEqual([r["exists"] for r in got], [True, False, True, False])

    def test_all_buckets_none(self):
        self.assertEqual(bucket_agents.all_buckets("demo", self.root), [])

    def test_names_refused(self):
        for dataset, bucket in (("nope", "news"), ("..", "news"), ("demo", "../x"),
                                ("demo", "News"), ("demo", "")):
            with self.assertRaises(ValueError):
                bucket_agents.definition_path(dataset, bucket, self.root)

    def test_data_root_from_env(self):
        self.write("news", filled())
        old = os.environ.get("TODOS_DATA_ROOT")
        os.environ["TODOS_DATA_ROOT"] = self.root
        try:
            self.assertTrue(bucket_agents.load("demo", "news")["ready"])
        finally:
            if old is None:
                del os.environ["TODOS_DATA_ROOT"]
            else:
                os.environ["TODOS_DATA_ROOT"] = old

    def test_cli(self):
        self.write("news", filled("free-rein"))
        self.write("admin", template())
        old = os.environ.get("TODOS_DATA_ROOT")
        os.environ["TODOS_DATA_ROOT"] = self.root
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = bucket_agents.main(["demo"])
            with contextlib.redirect_stderr(io.StringIO()):
                bad = bucket_agents.main(["nope"])
        finally:
            if old is None:
                del os.environ["TODOS_DATA_ROOT"]
            else:
                os.environ["TODOS_DATA_ROOT"] = old
        self.assertEqual((code, bad), (0, 2))
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[0], "admin  not ready, missing: the NOT FILLED IN YET line is "
                                   "still there, mode, purpose, processes, guidelines, "
                                   "may_touch, never_touch, good")
        self.assertEqual(lines[1], "news   ready (free-rein, on-assign)")


if __name__ == "__main__":
    unittest.main()
