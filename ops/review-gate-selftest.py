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
                self.assertTrue(gate.approved(pr, files, [{"user": {"login": "reviewer"}, "body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}]))

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
        for body, expected in [("VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok", True), ("VERDICT: APPROVE\r\nReviewed-SHA: abc\nReviewer: grok", True), ("VERDICT: CHANGES\nReviewed-SHA: abc\nReviewer: grok", False), ("VERDICT: APPROVE\nReviewed-SHA: old", False), ("prefix\nVERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok", False), ("VERDICT: APPROVE\nReviewed-SHA: abcd", False)]:
            with self.subTest(body=body):
                self.assertEqual(gate.approved(pr, [], [{"body": body, "user": {"login": "reviewer"}}]), expected)

    def test_skip_ci_title_fails_even_when_small_or_approved(self):
        comments = [{"user": {"login": "reviewer"}, "body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}]
        for title, expected in [("feat: x [skip ci]", False), ("[CI SKIP] x", False), ("x [no ci]", False),
                                ("x [skip actions]", False), ("x [actions skip]", False), ("skip ci mention", True), ("feat: x", True)]:
            with self.subTest(title=title):
                pr = {"title": title, "changed_files": 0, "additions": 1, "deletions": 0, "head": {"sha": "abc"}}
                self.assertEqual(gate.approved(pr, [], comments), expected)

    def test_skip_ci_auto_merge_commit_fails_even_when_approved(self):
        comments = [{"user": {"login": "reviewer"}, "body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}]
        for field in ("commit_title", "commit_message"):
            for value, expected in [("[skip ci]", False), ("[CI SKIP]", False), ("[no ci]", False), ("[skip actions]", False), ("[actions skip]", False), ("skip ci mention", True), (None, True)]:
                with self.subTest(field=field, value=value):
                    pr = {"title": "safe", "auto_merge": {field: value}, "changed_files": 0, "additions": 1, "deletions": 0, "head": {"sha": "abc"}}
                    self.assertEqual(gate.approved(pr, [], comments), expected)
        pr["auto_merge"] = None
        self.assertTrue(gate.approved(pr, [], comments))

    def test_event_adapter(self):
        pr = {"body": "Card: WR557.S3.J1", "base": {"ref": "main"}, "additions": 151, "deletions": 0, "head": {"sha": "abc"}, "changed_files": 1}
        for event in ({"number": 4}, {"issue": {"number": 4}}):
            for approved in (False, True):
                comments = [{"user": {"login": "reviewer"}, "body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}] if approved else []
                with patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "safe"}], comments, [], pr, {}]) as api:
                    gate.run(event, "owner/repo")
                    self.assertEqual(api.call_args.args[1]["state"], "success" if approved else "failure")
        pr["additions"] = 0
        for comments, expected in [([], "failure"), ([{"user": {"login": "reviewer"}, "body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: grok"}], "success")]:
            with patch.object(gate, "api", side_effect=[pr, {}, [], comments, [], pr, {}]) as api:
                gate.run({"number": 4}, "owner/repo")
                self.assertEqual(api.call_args.args[1]["state"], expected)
        with patch.object(gate, "api", return_value={"base": {"ref": "feature"}}) as api:
            gate.run({"issue": {"number": 4}}, "owner/repo")
            self.assertEqual(api.call_count, 1)
        with patch.object(gate, "api") as api:
            gate.run({"merge_group": {"head_sha": "queue"}}, "owner/repo")
            self.assertEqual(api.call_args.args[0], "repos/owner/repo/statuses/queue")
            self.assertEqual(api.call_args.args[1]["state"], "success")

    def test_mixed_sources_newest_valid_verdict_wins(self):
        pr = {"body": "Card: WR568.S1.J1", "base": {"ref": "main"}, "additions": 151,
              "deletions": 0, "head": {"sha": "abc"}, "changed_files": 1, "user": {"login": "jbookout"}}
        def item(verdict, date, **extra):
            return {"body": f"VERDICT: {verdict}\nReviewed-SHA: abc\nReviewer: grok", "user": {"login": "jbookout"}, **date, **extra}
        early = {"created_at": "2026-01-01T00:00:00Z"}
        late = {"submitted_at": "2026-01-02T00:00:00Z"}
        cases = [(item("CHANGES", early), item("APPROVE", late), "success"),
                 (item("APPROVE", early), item("CHANGES", late), "failure"),
                 (item("APPROVE", early), item("CHANGES", late, state="DISMISSED"), "success")]
        for comment, review, expected in cases:
            with self.subTest(expected=expected, review=review), patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "safe"}], [comment], [review], pr, {}]) as api:
                gate.run({"pull_request": {"number": 4}, "review": {}}, "owner/repo")
                self.assertEqual(api.call_args.args[1]["state"], expected)

    def test_later_changes_from_any_reviewer_blocks(self):
        pr = {"body": "Card: WR568.S1.J2", "base": {"ref": "main"}, "additions": 151,
              "deletions": 0, "head": {"sha": "abc"}, "changed_files": 1}
        approval = {"body": "VERDICT: APPROVE\nReviewed-SHA: abc\nReviewer: claude-opus",
                    "submitted_at": "2026-01-01T00:00:00Z", "state": "COMMENTED"}
        changes = {"body": "VERDICT: CHANGES\nReviewed-SHA: abc\nReviewer: Claude Sonnet 5.5 (independent)",
                   "created_at": "2026-01-02T00:00:00Z"}
        with patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "safe"}], [changes], [approval], pr, {}]) as api:
            gate.run({"issue": {"number": 4}}, "owner/repo")
            self.assertEqual(api.call_args.args[1]["state"], "failure")

    def test_reviewer_name_is_required_but_unrestricted(self):
        pr = {"changed_files": 0, "additions": 151, "deletions": 0, "head": {"sha": "abc"}}
        for reviewer, expected in [("Reviewer: Any independent reviewer", True),
                                   ("Reviewer: claude-sonnet cloud", True),
                                   ("Reviewer: ", False), ("Reviewer:   ", False), ("", False)]:
            with self.subTest(reviewer=reviewer):
                body = f"VERDICT: APPROVE\nReviewed-SHA: abc\n{reviewer}"
                self.assertEqual(gate.approved(pr, [], [{"body": body}]), expected)

    def test_real_event_shapes(self):
        pr = {"body": "Card: WR568.S1.J1", "base": {"ref": "main"}, "additions": 151,
              "deletions": 0, "head": {"sha": "abc"}, "changed_files": 1}
        events = [{"action": "created", "issue": {"number": 4}, "comment": {}},
                  {"action": "opened", "number": 4, "pull_request": {"number": 4}},
                  {"action": "synchronize", "number": 4, "pull_request": {"number": 4}},
                  {"action": "submitted", "pull_request": {"number": 4}, "review": {}}]
        for event in events:
            with self.subTest(event=event), patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "safe"}], [], [], pr, {}]) as api:
                gate.run(event, "owner/repo")
                self.assertEqual(api.call_args.args[1]["state"], "failure")

    def test_review_events_trigger_gate(self):
        workflow = pathlib.Path(__file__).parents[1] / ".github/workflows/review-gate.yml"
        self.assertRegex(workflow.read_text(),
                         r"(?m)^  pull_request_review:\n    types: \[submitted, edited, dismissed\]")

    def test_missing_card_fails_status(self):
        pr = {"base": {"ref": "main"}, "head": {"sha": "abc"}, "changed_files": 1,
              "additions": 1, "deletions": 0, "body": "", "user": {"type": "User"}}
        with patch.object(gate, "api", side_effect=[pr, {}, [{"filename": "app.py"}], [], [], pr, {}]) as api:
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
