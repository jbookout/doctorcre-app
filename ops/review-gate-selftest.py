"""Offline fixtures for the review-gate policy and GitHub event adapter."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gate", pathlib.Path(__file__).with_name("review-gate.py"))
assert spec is not None and spec.loader is not None
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReviewGate(unittest.TestCase):
    def test_added_machinery_requires_approval(self):
        pr = {"changed_files": 1, "additions": 1, "deletions": 0, "head": {"sha": "abc"}}
        for path, status, expected in [("scripts/foo.mjs", "added", False), (".github/workflows/check.yml", "added", False), ("scripts/foo.mjs", "modified", True), (".github/workflows/check.yml", "modified", True), ("docs/foo.md", "added", True)]:
            with self.subTest(path=path, status=status):
                files = [{"filename": path, "status": status}]
                self.assertEqual(gate.approved(pr, files, []), expected)
                self.assertTrue(gate.approved(pr, files, [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}]))

    def test_threshold(self):
        for net, expected in [(150, True), (151, False), (-20, True)]:
            with self.subTest(net=net):
                self.assertEqual(gate.approved({"changed_files": 0, "additions": net, "deletions": 0, "head": {"sha": "abc"}}, [], []), expected)

    def test_risky_paths_and_renames(self):
        paths = ["LaunchAgents/job", "a/job.plist", "ops/install-job.sh", "outlook/a", "hxstore/a", "hxprobe/a", "calendar.js", ".github/workflows/deploy.yml", "migrations/a", "db/a", "wrangler.toml", "tools/migrate.py"]
        for path in paths:
            for key in ("filename", "previous_filename"):
                with self.subTest(path=path, key=key):
                    self.assertFalse(gate.approved({"changed_files": 1, "head": {"sha": "abc"}, "additions": 0, "deletions": 0}, [{key: path}], []))

    def test_sha_bound_comment_format(self):
        pr = {"changed_files": 0, "additions": 151, "deletions": 0, "head": {"sha": "abc"}}
        for body, expected in [("VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok", True), ("VERDICT: APPROVE\r\nReviewed-SHA: abc\r\nReviewer: grok", True), ("VERDICT: CHANGES\nReviewed-SHA: abc\nReviewer: grok", False), ("VERDICT: APPROVE\nReviewed-SHA: old\nReviewer: grok", False), ("prefix\nVERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok", False), ("VERDICT: APPROVE\nReviewed-SHA: abcd\nReviewer: grok", False)]:
            with self.subTest(body=body):
                self.assertEqual(gate.approved(pr, [], [{"body": body}]), expected)

    def test_reviewer_third_line(self):
        pr = {"changed_files": 0, "additions": 151, "deletions": 0, "head": {"sha": "abc"}}
        for reviewer in ("grok", "Grok", "Grok 4.7", "the Dot", "orchestrator re-pin", "", "someone else", "grok impostor"):
            with self.subTest(reviewer=reviewer):
                body = f"VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: {reviewer}"
                self.assertEqual(gate.approved(pr, [], [{"body": body}]), reviewer in ("grok", "Grok", "Grok 4.7", "the Dot", "orchestrator re-pin"))
        for suffix in ("", "\n\nReviewer: grok", "\nOther: grok\nReviewer: grok"):
            self.assertFalse(gate.approved(pr, [], [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc" + suffix}]))

    def test_event_adapter(self):
        pr = {"base": {"ref": "main"}, "additions": 151, "deletions": 0, "head": {"sha": "abc"}, "changed_files": 1}
        for event in ({"number": 4}, {"issue": {"number": 4}}):
            for approved in (False, True):
                comments = [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}] if approved else []
                with patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "safe"}], comments, pr, {}]) as api:
                    gate.run(event, "owner/repo")
                    self.assertEqual(api.call_args.args[1]["state"], "success" if approved else "failure")
        pr["additions"] = 0
        for comments, expected in [([], "failure"), ([{"body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}], "success")]:
            with patch.object(gate, "api", side_effect=[pr, {}, [], comments, pr, {}]) as api:
                gate.run({"number": 4}, "owner/repo")
                self.assertEqual(api.call_args.args[1]["state"], expected)
        with patch.object(gate, "api", return_value={"base": {"ref": "feature"}}) as api:
            gate.run({"issue": {"number": 4}}, "owner/repo")
            self.assertEqual(api.call_count, 1)
        with patch.object(gate, "api") as api:
            gate.run({"merge_group": {"head_sha": "queue"}}, "owner/repo")
            self.assertEqual(api.call_args.args[0], "repos/owner/repo/statuses/queue")
            self.assertEqual(api.call_args.args[1]["state"], "success")

    def test_paginated_api(self):
        from types import SimpleNamespace
        with patch.object(gate.time, "sleep"), patch.object(gate.subprocess, "run", return_value=SimpleNamespace(stdout='[[{"body":"first"}],[{"body":"last"}]]')) as process:
            self.assertEqual(gate.api("repos/owner/repo/issues/4/comments"), [{"body": "first"}, {"body": "last"}])
            self.assertIn("--paginate", process.call_args.args[0])

if __name__ == "__main__":
    unittest.main()
