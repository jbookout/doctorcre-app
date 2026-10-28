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
    def test_card_line_gate(self):
        pr = {"body": "", "user": {"type": "User"}}
        for body, expected in [("", False), ("Card: WR557.S3.J1", True),
                               ("Intro\nCard: WR557.S3.J1\nEnd", True),
                               ("Card: WR557.S3.J1 extra", False),
                               (" Card: WR557.S3.J1", False),
                               ("Card: WR557.S3.J", False)]:
            with self.subTest(body=body):
                self.assertEqual(gate.card_allowed({**pr, "body": body}), expected)
        self.assertTrue(gate.card_allowed({**pr, "user": {"type": "Bot"}}))

    def test_added_machinery_requires_approval(self):
        pr = {"changed_files": 1, "additions": 1, "deletions": 0, "head": {"sha": "abc"}}
        for path, status, expected in [("scripts/foo.mjs", "added", False), (".github/workflows/check.yml", "added", False), ("scripts/foo.mjs", "modified", True), (".github/workflows/check.yml", "modified", True), ("docs/foo.md", "added", True)]:
            with self.subTest(path=path, status=status):
                files = [{"filename": path, "status": status}]
                self.assertEqual(gate.approved(pr, files, []), expected)
                self.assertTrue(gate.approved(pr, files, [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc"}]))

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
        for body, expected in [("VERDICT: APPROVE\nReviewed-SHA: abc", True), ("VERDICT: APPROVE\r\nReviewed-SHA: abc", True), ("VERDICT: CHANGES\nReviewed-SHA: abc", False), ("VERDICT: APPROVE\nReviewed-SHA: old", False), ("prefix\nVERDICT: APPROVE\nReviewed-SHA: abc", False), ("VERDICT: APPROVE\nReviewed-SHA: abcd", False)]:
            with self.subTest(body=body):
                self.assertEqual(gate.approved(pr, [], [{"body": body}]), expected)

    def test_skip_ci_title_fails_even_when_small_or_approved(self):
        comments = [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc"}]
        for title, expected in [("feat: x [skip ci]", False), ("[CI SKIP] x", False), ("x [no ci]", False),
                                ("x [skip actions]", False), ("x [actions skip]", False), ("skip ci mention", True), ("feat: x", True)]:
            with self.subTest(title=title):
                pr = {"title": title, "changed_files": 0, "additions": 1, "deletions": 0, "head": {"sha": "abc"}}
                self.assertEqual(gate.approved(pr, [], comments), expected)

    def test_skip_ci_auto_merge_commit_fails_even_when_approved(self):
        comments = [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc"}]
        for field in ("commit_title", "commit_message"):
            for value, expected in [("[skip ci]", False), ("[CI SKIP]", False), ("[no ci]", False), ("[skip actions]", False), ("[actions skip]", False), ("skip ci mention", True), (None, True)]:
                with self.subTest(field=field, value=value):
                    pr = {"title": "safe", "auto_merge": {field: value}, "changed_files": 0, "additions": 1, "deletions": 0, "head": {"sha": "abc"}}
                    self.assertEqual(gate.approved(pr, [], comments), expected)
        pr["auto_merge"] = None
        self.assertTrue(gate.approved(pr, [], comments))

    def test_changes_veto_is_bound_to_current_head(self):
        pr = {"changed_files": 0, "additions": 151, "deletions": 0, "head": {"sha": "abc"}}
        for sha, expected in [("abc", False), ("old", True)]:
            with self.subTest(changes_sha=sha):
                comments = [{"body": f"VERDICT: CHANGES\nReviewed-SHA: {sha}"},
                            {"body": "VERDICT: APPROVE\nReviewed-SHA: abc"}]
                self.assertEqual(gate.approved(pr, [], comments), expected)

    def test_event_adapter(self):
        pr = {"body": "Card: WR557.S3.J1", "base": {"ref": "main"}, "additions": 151, "deletions": 0, "head": {"sha": "abc"}, "changed_files": 1}
        for event in ({"number": 4}, {"issue": {"number": 4}}):
            for approved in (False, True):
                comments = [{"body": "VERDICT: APPROVE\nReviewed-SHA: abc"}] if approved else []
                with patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "safe"}], comments, pr, {}]) as api:
                    gate.run(event, "owner/repo")
                    self.assertEqual(api.call_args.args[1]["state"], "success" if approved else "failure")
        pr["additions"] = 0
        for comments, expected in [([], "failure"), ([{"body": "VERDICT: APPROVE\nReviewed-SHA: abc"}], "success")]:
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

    def test_review_body_approval_publishes_success(self):
        pr = {"body": "Card: WR568.S1.J2", "base": {"ref": "main"},
              "additions": 151, "deletions": 0, "head": {"sha": "abc"},
              "changed_files": 0, "user": {"login": "author"}}
        responses = {"repos/owner/repo/pulls/4": pr,
                     "repos/owner/repo/pulls/4/files?per_page=100": [],
                     "repos/owner/repo/issues/4/comments?per_page=100": [],
                     "repos/owner/repo/pulls/4/reviews?per_page=100": [
                         {"body": "VERDICT: APPROVE\nReviewed-SHA: abc", "user": {"login": "reviewer"}}]}
        statuses = []

        def api(path, payload=None):
            if payload is not None:
                statuses.append(payload)
                return {}
            return responses[path]

        with patch.object(gate, "api", side_effect=api):
            gate.run({"number": 4, "pull_request": {"number": 4}}, "owner/repo")
        self.assertEqual(statuses[-1]["state"], "success")

    def test_missing_card_fails_status(self):
        pr = {"base": {"ref": "main"}, "head": {"sha": "abc"}, "changed_files": 1,
              "additions": 1, "deletions": 0, "body": "", "user": {"type": "User"}}
        with patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "app.py"}], [], pr, {}]) as api:
            gate.run({"number": 4}, "owner/repo")
            status = api.call_args.args[1]
            self.assertEqual(status["state"], "failure")
            self.assertIn("Card: WR557.S3.J1", status["description"])

    def test_paginated_api(self):
        from types import SimpleNamespace
        with patch.object(gate.time, "sleep"), patch.object(gate.subprocess, "run", return_value=SimpleNamespace(stdout='[[{"body":"first"}],[{"body":"last"}]]')) as process:
            self.assertEqual(gate.api("repos/owner/repo/issues/4/comments"), [{"body": "first"}, {"body": "last"}])
            self.assertIn("--paginate", process.call_args.args[0])

if __name__ == "__main__":
    unittest.main()
