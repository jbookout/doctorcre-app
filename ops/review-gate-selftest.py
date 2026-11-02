"""Offline behavior tests for native App reviews and merge queue events."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('review-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReviewGate(unittest.TestCase):
    def setUp(self):
        self.pr = {'title': 'Fix', 'body': 'Card: WR700.S1.J1',
                   'user': {'login': 'author', 'type': 'User'}, 'changed_files': 1,
                   'additions': 151, 'deletions': 0, 'head': {'sha': 'head'},
                   'base': {'ref': 'main'}, 'auto_merge': None}
        self.files = [{'filename': 'js/safe.js', 'status': 'modified'}]
        self.login = 'doctorcre-carr-review[bot]'
        self.approval = {'user': {'login': self.login, 'type': 'Bot'},
                         'state': 'APPROVED', 'commit_id': 'head',
                         'submitted_at': '2026-01-01T00:00:00Z'}

    def test_current_head_native_approval(self):
        self.assertFalse(gate.approved(self.pr, self.files, [], self.login))
        self.assertTrue(gate.approved(self.pr, self.files, [self.approval], self.login))
        for extra in ({'commit_id': 'old'}, {'state': 'CHANGES_REQUESTED'},
                      {'state': 'DISMISSED'}, {'state': 'COMMENTED'}):
            with self.subTest(extra=extra):
                self.assertFalse(gate.approved(self.pr, self.files,
                                              [{**self.approval, **extra}], self.login))


    def test_app_identity_and_author_are_enforced(self):
        for login, kind in (('someone', 'User'), ('other[bot]', 'Bot'), (self.login, 'User')):
            with self.subTest(login=login, kind=kind):
                review = {**self.approval, 'user': {'login': login, 'type': kind}}
                self.assertFalse(gate.approved(self.pr, self.files, [review], self.login))
        self.assertFalse(gate.approved({**self.pr, 'user': self.approval['user']},
                                       self.files, [self.approval], self.login))
        for login in ('', 'human', 'other[bot]'):
            self.assertFalse(gate.approved(self.pr, self.files, [self.approval], login))
        self.assertTrue(gate.approved(self.pr, self.files, [self.approval], self.login[:-5].upper() + '[bot]'))

    def test_latest_decisive_review_governs(self):
        for state, expected in (('CHANGES_REQUESTED', False), ('DISMISSED', False),
                                ('COMMENTED', True), ('PENDING', True)):
            later = {**self.approval, 'state': state, 'submitted_at': '2026-01-02T00:00:00Z'}
            with self.subTest(state=state):
                self.assertEqual(gate.approved(self.pr, self.files,
                                              [later, self.approval], self.login), expected)
        old_changes = {**self.approval, 'state': 'CHANGES_REQUESTED', 'submitted_at': '2025-01-01'}
        self.assertTrue(gate.approved(self.pr, self.files, [self.approval, old_changes], self.login))
        self.assertFalse(gate.approved(self.pr, self.files, [{'body': 'APPROVE head reviewer'}], self.login))

    def test_existing_small_diff_exemption_and_app_veto(self):
        for net, expected in ((150, True), (151, False), (-20, True)):
            pr = {**self.pr, 'additions': net}
            self.assertEqual(gate.approved(pr, self.files, [], self.login), expected)
        small = {**self.pr, 'additions': 1}
        self.assertFalse(gate.approved(small, [], [], self.login))
        changes = {**self.approval, 'state': 'CHANGES_REQUESTED'}
        self.assertFalse(gate.approved(small, self.files, [changes], self.login))
        self.assertTrue(gate.approved(small, self.files, [{**changes, 'commit_id': 'old'}], self.login))
        self.assertFalse(gate.approved(small, self.files, [], 'human'))
        self.assertFalse(gate.approved({**self.pr, 'additions': 900},
                                       [{'filename': 'docs/notes.md'}], [], self.login))

    def test_risky_paths_and_renames_need_review(self):
        small = {**self.pr, 'additions': 1}
        paths = ['LaunchAgents/job', 'a/job.plist', 'ops/install-job.sh', 'outlook/a',
                 'hxstore/a', 'hxprobe/a', 'calendar.js', '.github/workflows/deploy.yml',
                 'migrations/a', 'db/a', 'wrangler.toml', 'tools/migrate.py']
        for path in paths:
            for key in ('filename', 'previous_filename'):
                with self.subTest(path=path, key=key):
                    self.assertFalse(gate.approved(small, [{'filename': 'safe', key: path}], [], self.login))
        for path in ('scripts/foo.mjs', '.github/workflows/check.yml', 'ops/gate.py'):
            self.assertFalse(gate.approved(small, [{'filename': path, 'status': 'added'}], [], self.login))
        self.assertTrue(gate.approved(small, [{'filename': 'scripts/foo.mjs', 'status': 'modified'}], [], self.login))

    def test_skip_ci_markers_in_title_and_squash_metadata(self):
        for marker in ('[skip ci]', '[CI SKIP]', '[no ci]', '[skip actions]', '[actions skip]'):
            for field in ('title', 'commit_title', 'commit_message'):
                pr = {**self.pr, 'additions': 1}
                if field == 'title':
                    pr['title'] = marker
                else:
                    pr['auto_merge'] = {field: marker}
                with self.subTest(marker=marker, field=field):
                    self.assertFalse(gate.approved(pr, self.files, [self.approval], self.login))

    def test_card_line(self):
        for body, expected in (('', False), ('Card: WR700.S1.J1', True),
                               ('Intro\nCard: WR700.S1.J1\nEnd', True),
                               (' Card: WR700.S1.J1', False), ('Card: WR700.S1.J1 extra', False)):
            self.assertEqual(gate.card_allowed({**self.pr, 'body': body}), expected)
        self.assertTrue(gate.card_allowed({**self.pr, 'body': '', 'user': {'type': 'Bot'}}))

    def test_event_adapter_only_reads_native_reviews(self):
        events = ({'number': 4}, {'pull_request': {'number': 4}, 'review': {}})
        for event in events:
            for reviews, expected in (([], 1), ([self.approval], 0)):
                with patch.dict(gate.os.environ, {'CARR_REVIEW_APP_LOGIN': self.login}), \
                        patch.object(gate, 'api', side_effect=[self.pr, {}, self.files, reviews, self.pr, {}]) as api:
                    self.assertEqual(gate.run(event, 'owner/repo'), expected)
                    self.assertEqual(api.call_args.args[0], 'repos/owner/repo/statuses/head')
                    self.assertEqual(api.call_args.args[1]['state'], 'failure' if expected else 'success')
                    self.assertIn('/pulls/4/reviews?', api.call_args_list[3].args[0])
                    self.assertFalse(any('/issues/' in c.args[0] for c in api.call_args_list))

    def test_missing_config_and_card_fail(self):
        for login, body in (('', self.pr['body']), ('human', self.pr['body']), (self.login, '')):
            pr = {**self.pr, 'body': body}
            with patch.dict(gate.os.environ, {'CARR_REVIEW_APP_LOGIN': login}), \
                    patch.object(gate, 'api', side_effect=[pr, {}, self.files, [self.approval], pr, {}]) as api:
                self.assertEqual(gate.run({'number': 4}, 'owner/repo'), 1)
                status = api.call_args.args[1]
                self.assertEqual(status['state'], 'failure')
                self.assertIn('CARR_REVIEW_APP_LOGIN' if body else 'Card:', status['description'])

    def test_unrelated_base_repository_push_still_publishes_success(self):
        pr = {**self.pr, 'base': {'ref': 'main', 'repo': {'pushed_at': 'before'}}}
        latest = {**pr, 'base': {**pr['base'], 'repo': {'pushed_at': 'after'}}}
        with patch.dict(gate.os.environ, {'CARR_REVIEW_APP_LOGIN': self.login}), \
                patch.object(gate, 'api', side_effect=[pr, {}, self.files, [self.approval], latest, {}]) as api:
            self.assertEqual(gate.run({'number': 4}, 'owner/repo'), 0)
            statuses = [c.args[1]['state'] for c in api.call_args_list if len(c.args) == 2]
            self.assertEqual(statuses, ['pending', 'success'])

    def test_midflight_head_or_metadata_change_never_publishes_success(self):
        variants = ({'head': {'sha': 'new'}}, {'title': '[skip ci]'}, {'body': ''},
                    {'base': {'ref': 'other'}}, {'auto_merge': {'commit_message': '[skip ci]'}})
        for extra in variants:
            with patch.dict(gate.os.environ, {'CARR_REVIEW_APP_LOGIN': self.login}), \
                    patch.object(gate, 'api', side_effect=[self.pr, {}, self.files, [self.approval], {**self.pr, **extra}]) as api:
                gate.run({'number': 4}, 'owner/repo')
                self.assertEqual(api.call_count, 5)
                self.assertEqual(api.call_args_list[1].args[1]['state'], 'pending')
        with patch.object(gate, 'api', return_value={'base': {'ref': 'other'}}) as api:
            gate.run({'number': 4}, 'owner/repo')
            self.assertEqual(api.call_count, 1)

    def test_paginated_review_reads(self):
        from types import SimpleNamespace
        result = SimpleNamespace(stdout='[[{"state":"APPROVED"}],[{"state":"DISMISSED"}]]')
        with patch.object(gate.time, 'sleep'), patch.object(gate.subprocess, 'run', return_value=result) as process:
            self.assertEqual(gate.api('repos/owner/repo/pulls/4/reviews'),
                             [{'state': 'APPROVED'}, {'state': 'DISMISSED'}])
            self.assertIn('--paginate', process.call_args.args[0])


class QueueAndCutover(unittest.TestCase):
    setUp = ReviewGate.setUp
    def exercise_queue(self, count=1, missing=False, moved=False, changed=False,
                       broken=False, truncated=False, unknown=False, dispatch=False,
                       login="doctorcre-carr-review[bot]"):
        event = {'merge_group': {'head_ref': 'refs/heads/gh-readonly-queue/main/pr-4-base',
                                'head_sha': 'queue' + str(count), 'base_sha': 'base',
                                'base_ref': 'refs/heads/main'}}
        prs = {n: {**self.pr, 'number': n, 'state': 'open', 'additions': 900,
                   'head': {'sha': 'head' + str(n)}} for n in range(4, 4 + count)}
        entries = [{'headCommit': {'oid': 'queue' + str(i + 1)},
                    'pullRequest': {'number': n, 'headRefOid': pr['head']['sha']}}
                   for i, (n, pr) in enumerate(prs.items())]
        calls = []
        def api(path, payload=None):
            calls.append((path, payload))
            if path == 'graphql':
                if broken: raise ValueError('lookup failed')
                nodes = entries
                if changed and sum(p == 'graphql' for p, _ in calls) > 1:
                    nodes = [{**e, 'pullRequest': {**e['pullRequest'], 'headRefOid': 'moved'}}
                             for e in entries]
                return {'data': {'repository': {'mergeQueue': {'entries': {
                    'nodes': nodes, 'pageInfo': {'hasNextPage': truncated, 'endCursor': None}}}}}}
            if '/compare/' in path:
                commits = [{'sha': e['headCommit']['oid']} for e in entries]
                if unknown: commits.insert(0, {'sha': 'unknown'})
                return {'commits': commits, 'total_commits': len(commits)}
            if payload: return {}
            if path.endswith('/git/ref/heads/main'): return {'object': {'sha': 'base'}}
            n = int(path.split('/pulls/')[1].split('/')[0])
            if '/files?' in path: return self.files
            if '/reviews?' in path:
                return [] if missing and n == 3 + count else [{**self.approval, 'commit_id': 'head' + str(n)}]
            if moved and n == 4:
                return {**prs[n], 'head': {'sha': 'moved'}}
            return prs[n]
        if dispatch:
            event = {'inputs': {'queue_head_sha': 'a' * 40}}
            entries[-1]['headCommit']['oid'] = 'a' * 40
        with patch.dict(gate.os.environ, {'CARR_REVIEW_APP_LOGIN': login}), \
                patch.object(gate, 'api', side_effect=api):
            result = gate.run(event, 'owner/repo')
        self.assertEqual(calls[-1][1]['state'], 'success' if result == 0 else 'failure')
        return result, calls

    def test_single_squash_queue_entry(self):
        self.assertEqual(self.exercise_queue()[0], 0)

    def test_multiple_squash_queue_entries(self):
        result, calls = self.exercise_queue(count=3)
        self.assertEqual(result, 0)
        self.assertTrue(all(any(p.endswith('/pulls/' + str(n)) for p, _ in calls)
                            for n in (4, 5, 6)))

    def test_multiple_queue_entries_need_every_approval(self):
        self.assertEqual(self.exercise_queue(count=3, missing=True)[0], 1)

    def test_queue_moved_head_is_refused(self):
        self.assertEqual(self.exercise_queue(moved=True)[0], 1)

    def test_queue_missing_approval_is_refused(self):
        self.assertEqual(self.exercise_queue(missing=True)[0], 1)

    def test_queue_missing_reviewer_setting_is_refused(self):
        self.assertEqual(self.exercise_queue(login="")[0], 1)

    def test_queue_changed_after_approval_is_refused(self):
        self.assertEqual(self.exercise_queue(changed=True)[0], 1)

    def test_queue_lookup_failure_is_refused(self):
        self.assertEqual(self.exercise_queue(broken=True)[0], 1)

    def test_queue_incomplete_pagination_is_refused(self):
        self.assertEqual(self.exercise_queue(truncated=True)[0], 1)

    def test_queue_unmapped_commit_is_refused(self):
        self.assertEqual(self.exercise_queue(unknown=True)[0], 1)

    def test_manual_queue_recovery_checks_approvals(self):
        self.assertEqual(self.exercise_queue(dispatch=True)[0], 0)
        self.assertEqual(self.exercise_queue(dispatch=True, missing=True)[0], 1)

    def test_queue_reads_all_pages(self):
        def page(nodes, more=False, cursor=None):
            return {'data': {'repository': {'mergeQueue': {'entries': {
                'nodes': nodes, 'pageInfo': {'hasNextPage': more, 'endCursor': cursor}}}}}}
        entry = {'headCommit': {'oid': 'queue'},
                 'pullRequest': {'number': 4, 'headRefOid': 'head'}}
        responses = [page([{'headCommit': None}], True, 'next'), page([entry]),
                     {'commits': [{'sha': 'queue'}], 'total_commits': 1}]
        with patch.object(gate, 'api', side_effect=responses) as api:
            self.assertEqual(gate.queue_prs('repos/owner/repo',
                {'base_sha': 'base', 'head_sha': 'queue'}), {4: 'head'})
            self.assertEqual(api.call_args_list[1].args[1]['variables']['cursor'], 'next')

    def test_manual_recovery_rejects_invalid_sha(self):
        with patch.object(gate, 'api') as api:
            with self.assertRaises(ValueError):
                gate.run({'inputs': {'queue_head_sha': 'not-a-sha'}}, 'owner/repo')
            api.assert_not_called()

    def test_dispatch_evaluates_all_open_main_heads(self):
        prs = [{'number': 4}, {'number': 5}]
        with patch.object(gate, 'api', return_value=prs) as api, patch.object(gate, 'evaluate_pr', return_value=0) as evaluate:
            self.assertEqual(gate.run({}, 'owner/repo'), 0)
            self.assertIn('state=open&base=main', api.call_args.args[0])
            self.assertEqual([c.args[1] for c in evaluate.call_args_list], [4, 5])
        workflow = Path(__file__).resolve().parents[1] / '.github/workflows/review-gate.yml'
        text = workflow.read_text()
        self.assertIn('workflow_dispatch:', text)
        self.assertIn('queue_head_sha:', text)
        self.assertIn("github.event_name == 'workflow_dispatch' && github.sha || github.event.repository.default_branch", text)


if __name__ == '__main__':
    unittest.main()
