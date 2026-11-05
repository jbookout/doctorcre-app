from contextlib import chdir
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / 'scripts/production-proof-plan.py'
NON_PRODUCT = '## Production proof\nn/a: CI tooling and hosted workflow checks only'
BODY = '## Production proof\nproofs/requirements/app-proof-admission.json\n'
CI_PATHS = ('.github/action-pins.json', '.github/workflows/conflict-notice.yml',
            'scripts/check-action-pins.mjs')


def module():
    spec = importlib.util.spec_from_file_location('adapter', PROGRAM)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.adapter = module()
        self.validator, self.contract = self.adapter.load_pinned(ROOT)

    def snapshot(self, body=NON_PRODUCT, paths=CI_PATHS, event='pull_request', requirement=None):
        return self.adapter.Snapshot(event, 'a' * 40, 'b' * 40, body, tuple(paths), requirement)

    def test_bulk_settle_app_declaration_is_admitted_without_attesting_execution(self):
        # PR 654 declaration at 3d1e0cf98b8a9768800a447c48f4ed2ab7df9b1c.
        requirement = (ROOT / 'test/fixtures/wr617-s12-production-proof.json').read_text()
        decision = self.adapter.admission(
            self.snapshot(BODY, ['src/ui/home/bulk-controls.tsx'], requirement=requirement),
            self.validator, self.contract)
        self.assertEqual(decision.status, 'admitted', decision)
        self.assertIn('execution unproven', decision.reason)

    def test_snapshot_decisions(self):
        cases = [
            ('CI', NON_PRODUCT, CI_PATHS, 'pull_request', 'admitted', 'non-product'),
            ('docs', NON_PRODUCT, ['docs/a.md'], 'pull_request', 'admitted', 'non-product'),
            ('app', BODY, ['src/ui/example.tsx'], 'pull_request', 'refused', 'requirement missing'),
            ('mixed', NON_PRODUCT, [*CI_PATHS, 'src/ui/example.tsx'], 'pull_request', 'refused', 'n/a requires'),
            ('build', NON_PRODUCT, ['scripts/prepare-offline-tour.mjs'], 'pull_request', 'refused', 'n/a requires'),
            ('near match', NON_PRODUCT, ['scripts/check-action-pins.mjs.extra'], 'pull_request', 'refused', 'n/a requires'),
            ('missing', '## Summary\nCI only', CI_PATHS, 'pull_request', 'refused', 'exactly one'),
            ('malformed', '## Production proof\n{}', CI_PATHS, 'pull_request', 'refused', 'must name'),
            ('placeholder', '## Production proof\nn/a: TODO', CI_PATHS, 'pull_request', 'refused', 'real reason'),
            ('duplicate', NON_PRODUCT + '\n' + NON_PRODUCT, CI_PATHS, 'pull_request', 'refused', 'exactly one'),
            ('comment', '<!--\n' + NON_PRODUCT + '\n-->', CI_PATHS, 'pull_request', 'refused', 'exactly one'),
            ('escape', '## Production proof\n../escape.json', CI_PATHS, 'pull_request', 'refused', 'must name'),
            ('push', '', [], 'push', 'skipped', 'not evaluated'),
            ('queue', '', [], 'merge_group', 'skipped', 'not evaluated'),
        ]
        for name, body, paths, event, status, reason in cases:
            with self.subTest(name=name):
                decision = self.adapter.admission(self.snapshot(body, paths, event), self.validator, self.contract)
                self.assertEqual(decision.status, status, decision)
                self.assertIn(reason, decision.reason)

    def test_performance_harness_declaration_keeps_product_proof_required(self):
        harness = 'scripts/performance-scenarios.mjs'
        paths = (harness, 'test/performance-scenarios-browser.test.mjs')
        cases = [
            (paths, 'admitted', 'non-product'),
            ((*paths, 'src/ui/home/home.tsx'), 'refused', 'n/a requires'),
            ((*paths, 'js/home-dashboard.js'), 'refused', 'n/a requires'),
            ((*paths, 'scripts/prepare-offline-tour.mjs'), 'refused', 'n/a requires'),
            ((harness + '.extra',), 'refused', 'n/a requires'),
            (('scripts/performance-scenarios-other.mjs',), 'refused', 'n/a requires'),
        ]
        for changed, status, reason in cases:
            with self.subTest(paths=changed):
                decision = self.adapter.admission(
                    self.snapshot(paths=changed), self.validator, self.contract)
                self.assertEqual(decision.status, status, decision)
                self.assertIn(reason, decision.reason)

    def test_pure_core_never_reads_git_files_or_network(self):
        with patch('subprocess.check_output', side_effect=AssertionError('subprocess')), \
             patch.object(Path, 'read_text', side_effect=AssertionError('file read')):
            self.assertEqual(self.adapter.admission(self.snapshot(), self.validator, self.contract).status, 'admitted')
            self.assertEqual(self.adapter.admission(self.snapshot(BODY, ['src/ui/a.tsx']), self.validator, self.contract).status, 'refused')

    def test_requirement_validation_is_pure_and_cannot_borrow_proof(self):
        value = json.loads((ROOT / 'proofs/requirements/app-proof-admission.json').read_text())
        for target, runner in [('studio', 'studio-run-receipt.v1'),
                               ('worker', 'worker-release-smoke.v1')]:
            with self.subTest(target=target):
                for declared_target, reason in [(target, 'changed runtime target missing'),
                                                ('app', 'target has no registered runner')]:
                    value['targets'] = [declared_target]
                    value['assertions'][0]['runner'] = runner
                    snap = self.snapshot(BODY, ['src/ui/a.tsx'], requirement=json.dumps(value))
                    decision = self.adapter.admission(snap, self.validator, self.contract)
                    self.assertEqual(decision.status, 'refused', decision)
                    self.assertIn(reason, decision.reason)
        value['targets'] = ['app']
        value['assertions'][0]['runner'] = 'app-release-live-walk.v1'
        snap = self.snapshot(BODY, ['src/ui/a.tsx'], requirement=json.dumps(value))
        with patch('subprocess.check_output', side_effect=AssertionError('subprocess')), \
             patch.object(Path, 'read_text', side_effect=AssertionError('file read')):
            self.assertEqual(self.adapter.admission(snap, self.validator, self.contract).status, 'admitted')
        del value['safety']
        decision = self.adapter.admission(snap._replace(requirement_json=json.dumps(value)), self.validator, self.contract)
        self.assertEqual(decision.status, 'refused', decision)
        self.assertIn('missing or unknown', decision.reason)

    def test_app_requirement_refuses_missing_invalid_and_unsafe_declarations(self):
        value = json.loads((ROOT / 'test/fixtures/wr617-s12-production-proof.json').read_text())
        snap = self.snapshot(BODY, ['src/ui/home/bulk-controls.tsx'])
        for requirement, reason in [(None, 'requirement missing'), ('{', 'Expecting'),
                                    ('{}', 'missing or unknown')]:
            with self.subTest(requirement=requirement):
                decision = self.adapter.admission(snap._replace(requirement_json=requirement), self.validator, self.contract)
                self.assertEqual(decision.status, 'refused', decision)
                self.assertIn(reason, decision.reason)
        for field, invalid in [('read_only', False), ('no_sends', False), ('max_requests', 101),
                               ('max_records', 1001), ('max_runtime_seconds', 301),
                               ('max_artifact_bytes', 1048577)]:
            with self.subTest(field=field):
                original = value['safety'][field]
                value['safety'][field] = invalid
                decision = self.adapter.admission(snap._replace(requirement_json=json.dumps(value)), self.validator, self.contract)
                self.assertEqual(decision.status, 'refused', decision)
                self.assertIn('safety.' + field, decision.reason)
                value['safety'][field] = original

    def test_edited_body_removal(self):
        snapshot = self.snapshot()
        self.assertEqual(self.adapter.admission(snapshot, self.validator, self.contract).status, 'admitted')
        self.assertEqual(self.adapter.admission(snapshot._replace(body='removed'), self.validator, self.contract).status, 'refused')

    def test_requirement_edge_cases(self):
        value = json.loads((ROOT / 'proofs/requirements/app-proof-admission.json').read_text())
        value['targets'] = ['studio']
        value['assertions'][0]['runner'] = 'studio-run-receipt.v1'
        snapshot = self.snapshot(BODY, ['test/a.test.mjs'], requirement=json.dumps(value))
        self.assertEqual(self.adapter.admission(snapshot, self.validator, self.contract).status, 'admitted')
        with patch('subprocess.check_output', side_effect=AssertionError('subprocess')), \
             patch.object(Path, 'read_text', side_effect=AssertionError('file read')):
            self.assertEqual(self.adapter.admission(snapshot, self.validator, self.contract).status, 'admitted')
        for malformed, reason in [(None, 'missing'), ('{', 'Expecting')]:
            self.assertIn(reason, self.adapter.admission(snapshot._replace(requirement_json=malformed), self.validator, self.contract).reason)
        value['assertions'].append(value['assertions'][0])
        self.assertIn('duplicate assertion', self.adapter.admission(snapshot._replace(requirement_json=json.dumps(value)), self.validator, self.contract).reason)
        value['assertions'].pop()
        value['assertions'][0]['runner'] = 'unknown.v1'
        self.assertIn('unregistered runner', self.adapter.admission(snapshot._replace(requirement_json=json.dumps(value)), self.validator, self.contract).reason)

    def test_pin_drift(self):
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ['contracts/production-proof-plan.v1.json', 'scripts/vendor/production-proof-plan.v1.py']:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, path)
            self.adapter.load_pinned(root)
            for relative in ['contracts/production-proof-plan.v1.json', 'scripts/vendor/production-proof-plan.v1.py']:
                path = root / relative
                original = path.read_bytes()
                path.write_bytes(original + b' ')
                with self.assertRaisesRegex(ValueError, 'drift'):
                    self.adapter.load_pinned(root)
                path.write_bytes(original)

    def test_real_aggregate(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('ready_for_review, edited', workflow)
        self.assertIn('needs: [checks, shards, performance, live, production-proof]', workflow)
        script = 'test "$CHECKS" = success' + workflow.split('          test "$CHECKS" = success', 1)[1].split('\n\n  preview:', 1)[0]
        for event, proof, expected in [('pull_request', 'failure', 1), ('pull_request', 'success', 0),
                                       ('push', 'skipped', 0), ('merge_group', 'skipped', 0)]:
            settings = dict(os.environ, CHECKS='success', LIVE='success', SHARDS='success',
                            PERFORMANCE='success', EVENT=event, PRODUCTION_PROOF=proof)
            self.assertEqual(subprocess.run(['bash', '-e', '-c', script], env=settings, timeout=5).returncode, expected)


class GitHubAdapterTest(unittest.TestCase):
    def setUp(self):
        self.adapter = module()
        self.validator, self.contract = self.adapter.load_pinned(ROOT)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic test')
        self.git('config', 'user.email', 'synthetic@example.invalid')
        self.commit('docs/base.md', 'base')
        self.base = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-qb', 'pr')
        self.commit('scripts/check-action-pins.mjs', 'ci only')
        self.head = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-qb', 'new-main', self.base)
        self.commit('src/ui/unrelated.tsx', 'unrelated main')
        self.git('merge', '--no-edit', 'pr')
        self.event = {'repository': {'full_name': 'jbookout/doctorcre-app'},
                      'pull_request': {'number': 1, 'body': NON_PRODUCT,
                                       'base': {'sha': self.base}, 'head': {'sha': self.head}}}

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True, stderr=subprocess.PIPE, timeout=10).strip()

    def commit(self, path, text):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)
        self.git('add', path)
        self.git('commit', '-qm', 'synthetic fixture')

    def collect(self):
        return self.adapter.github_snapshot(self.event, self.validator, self.contract, self.root)

    def test_merge_checkout_is_not_pr_source(self):
        self.assertIn('src/ui/unrelated.tsx', self.git('diff', '--name-only', self.base + '...HEAD'))
        self.assertEqual(self.git('diff', '--name-only', self.base + '...' + self.head), 'scripts/check-action-pins.mjs')
        with patch.object(self.validator, 'github_metadata', return_value={}):
            snapshot = self.collect()
        self.assertEqual(snapshot.paths, ('scripts/check-action-pins.mjs',))
        self.assertEqual(snapshot.head_sha, self.head)
        self.assertEqual(self.adapter.admission(snapshot, self.validator, self.contract).status, 'admitted')
        self.git('checkout', '-q', 'pr')
        self.commit('src/ui/own.tsx', 'own product')
        self.event['pull_request']['head']['sha'] = self.git('rev-parse', 'HEAD')
        with patch.object(self.validator, 'github_metadata', return_value={}):
            self.assertEqual(self.adapter.admission(self.collect(), self.validator, self.contract).status, 'refused')

    def test_stale_metadata_and_api_failure(self):
        for failure in [ValueError('stale PR event'), OSError('offline')]:
            with patch.object(self.validator, 'github_metadata', side_effect=failure):
                with self.assertRaises(type(failure)):
                    self.collect()
        for body, head in [('removed', self.head), (NON_PRODUCT, 'c' * 40)]:
            response = {'data': {'repository': {'pullRequest': {'body': body, 'headRefOid': head}}}}
            with patch.object(self.validator, 'command', return_value=json.dumps(response)):
                with self.assertRaisesRegex(ValueError, 'stale'):
                    self.collect()

    def test_invalid_or_unavailable_sha_refuses(self):
        for sha in ['HEAD', '--help', 'a' * 40]:
            self.event['pull_request']['head']['sha'] = sha
            with patch.object(self.validator, 'github_metadata', return_value={}):
                with self.assertRaises((ValueError, subprocess.SubprocessError)):
                    self.collect()

    def test_cli_in_merge_checkout_and_metadata_recheck(self):
        event_file = self.root / 'event.json'
        event_file.write_text(json.dumps(self.event))
        for responses, expected in [([{}, {}], 0), ([{}, ValueError('stale PR event')], 1)]:
            with chdir(self.root), patch.dict(os.environ, GITHUB_EVENT_NAME='pull_request', GITHUB_EVENT_PATH=str(event_file)), \
                 patch.object(sys, 'argv', [str(PROGRAM), '--root', str(self.root)]), \
                 patch.object(self.adapter, 'load_pinned', return_value=(self.validator, self.contract)), \
                 patch.object(self.validator, 'github_metadata', side_effect=responses) as metadata:
                self.assertEqual(self.adapter.main(), expected)
                self.assertEqual(metadata.call_count, 2)


    def test_whitespace_in_git_paths_is_preserved(self):
        self.git('checkout', '-q', 'pr')
        self.commit(' docs/a.md', 'product path with leading space')
        self.event['pull_request']['head']['sha'] = self.git('rev-parse', 'HEAD')
        with patch.object(self.validator, 'github_metadata', return_value={}):
            snapshot = self.collect()
        self.assertIn(' docs/a.md', snapshot.paths)
        self.assertEqual(self.adapter.admission(snapshot, self.validator, self.contract).status, 'refused')

    def test_symlink_requirement_and_missing_requirement_refuse(self):
        self.git('checkout', '-q', 'pr')
        path = self.root / 'proofs/requirements/example.json'
        path.parent.mkdir(parents=True)
        path.symlink_to('../../docs/base.md')
        self.git('add', 'proofs/requirements/example.json')
        self.git('commit', '-qm', 'symlink fixture')
        self.event['pull_request']['head']['sha'] = self.git('rev-parse', 'HEAD')
        for name in ['example.json', 'missing.json']:
            self.event['pull_request']['body'] = '## Production proof\nproofs/requirements/' + name
            with patch.object(self.validator, 'github_metadata', return_value={}):
                with self.assertRaisesRegex(ValueError, 'missing or symlink'):
                    self.collect()

    def test_git_timeout_and_input_bounds(self):
        with patch.object(self.validator, 'github_metadata', return_value={}), \
             patch('subprocess.check_output', side_effect=subprocess.TimeoutExpired('git', 15)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.collect()
        self.event['pull_request']['body'] = 'x' * 1048577
        with self.assertRaisesRegex(ValueError, '1 MiB'):
            self.collect()

    def test_requirement_bytes_are_from_pr_head(self):
        self.git('checkout', '-q', 'pr')
        path = 'proofs/requirements/example.json'
        requirement = (ROOT / 'proofs/requirements/app-proof-admission.json').read_text()
        self.commit(path, requirement)
        self.event['pull_request']['head']['sha'] = self.git('rev-parse', 'HEAD')
        self.event['pull_request']['body'] = '## Production proof\n' + path
        (self.root / path).write_text('uncommitted contamination')
        with patch.object(self.validator, 'github_metadata', return_value={}):
            self.assertEqual(self.collect().requirement_json.strip(), requirement.strip())


if __name__ == '__main__':
    unittest.main()
