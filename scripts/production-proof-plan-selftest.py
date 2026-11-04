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
BODY = '## Production proof\nproofs/requirements/app-proof-admission.json\n'


def module():
    spec = importlib.util.spec_from_file_location('adapter', PROGRAM)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'proofs/requirements').mkdir(parents=True)
        source = ROOT / 'proofs/requirements/app-proof-admission.json'
        if source.exists():
            (self.root / 'proofs/requirements/app-proof-admission.json').write_bytes(source.read_bytes())
        self.body = self.root / 'body.md'
        self.files = self.root / 'files.json'

    def run_plan(self, body, paths=None):
        self.body.write_text(body)
        self.files.write_text(json.dumps(paths or ['src/ui/example.tsx']))
        return subprocess.run([sys.executable, str(PROGRAM), '--root', str(self.root),
            '--body-file', str(self.body), '--files-file', str(self.files)],
            capture_output=True, text=True, timeout=20)

    def test_app_product_pr_without_proof_declaration_fails(self):
        result = self.run_plan('## Summary\nProduct change')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Production proof', result.stdout)

    def test_valid_declaration_passes(self):
        result = self.run_plan(BODY)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print('Synthetic product declaration accepted:', result.stdout.strip())

    def test_same_head_body_removal_fails(self):
        self.assertEqual(self.run_plan(BODY).returncode, 0)
        result = self.run_plan('## Summary\nSame head, declaration removed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Production proof', result.stdout)
        print('Synthetic same-head removal refused:', result.stdout.strip())

    def test_p1_exemptions_and_mixed_paths(self):
        body = '## Production proof\nn/a: documentation and tests only'
        for paths in [['test/example.test.mjs'], ['.github/workflows/ci.yml'], ['docs/a.md']]:
            self.assertEqual(self.run_plan(body, paths).returncode, 0)
            self.assertNotEqual(self.run_plan(body, paths + ['src/ui/example.tsx']).returncode, 0)

    def test_malformed_declarations(self):
        for body in ['## Production proof\n{}', '## Production proof\nn/a: TODO',
                     BODY + BODY, '## Production proof\n../escape.json',
                     '## Production proof\n<!-- ' + BODY + ' -->']:
            self.assertNotEqual(self.run_plan(body).returncode, 0, body)

    def test_missing_requirement_field_fails(self):
        path = self.root / 'proofs/requirements/app-proof-admission.json'
        value = json.loads(path.read_text())
        del value['safety']
        path.write_text(json.dumps(value))
        self.assertNotEqual(self.run_plan(BODY).returncode, 0)

    def test_pin_and_contract_drift(self):
        plan = module()
        self.assertEqual(plan.load_pinned(ROOT)[1]['$id'], 'carr-production-proof-plan.v1')
        import shutil
        for relative in ['contracts/production-proof-plan.v1.json', 'scripts/vendor/production-proof-plan.v1.py']:
            with self.subTest(relative=relative):
                copy = self.root / relative.replace('/', '_')
                (copy / 'contracts').mkdir(parents=True)
                shutil.copyfile(ROOT / 'contracts/production-proof-plan.v1.json', copy / 'contracts/production-proof-plan.v1.json')
                (copy / 'scripts/vendor').mkdir(parents=True)
                shutil.copyfile(ROOT / 'scripts/vendor/production-proof-plan.v1.py', copy / 'scripts/vendor/production-proof-plan.v1.py')
                path = copy / relative
                path.write_text(path.read_text() + ' ')
                with self.assertRaisesRegex(ValueError, 'drift'):
                    plan.load_pinned(copy)

    def test_current_metadata_and_stale_body_or_head(self):
        plan, _ = module().load_pinned(ROOT)
        event = {'repository': {'full_name': 'jbookout/doctorcre-app'},
                 'pull_request': {'number': 1, 'body': BODY, 'head': {'sha': 'b' * 40}}}
        for body, head in [(BODY, 'b' * 40), ('removed', 'b' * 40), (BODY, 'c' * 40)]:
            response = {'data': {'repository': {'pullRequest': {'body': body, 'headRefOid': head}}}}
            with patch.object(plan, 'command', return_value=json.dumps(response)):
                if body == BODY and head == 'b' * 40:
                    plan.github_metadata(event)
                else:
                    with self.assertRaisesRegex(ValueError, 'stale'):
                        plan.github_metadata(event)

    def test_edited_event_and_api_failure_refuse(self):
        adapter = module()
        validator, contract = adapter.load_pinned(ROOT)
        event = {'action': 'edited', 'repository': {'full_name': 'jbookout/doctorcre-app'},
                 'pull_request': {'number': 1, 'body': '', 'base': {'sha': 'a' * 40}, 'head': {'sha': 'b' * 40}}}
        event_path = self.root / 'event.json'
        event_path.write_text(json.dumps(event))
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_EVENT_PATH': str(event_path)}), \
             patch.object(sys, 'argv', [str(PROGRAM)]), \
             patch.object(adapter, 'load_pinned', return_value=(validator, contract)), \
             patch.object(validator, 'command', return_value='src/ui/example.tsx\0'), \
             patch.object(validator, 'github_metadata', return_value={}):
            self.assertEqual(adapter.main(), 1)
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_EVENT_PATH': str(event_path)}), \
             patch.object(sys, 'argv', [str(PROGRAM)]), \
             patch.object(adapter, 'load_pinned', return_value=(validator, contract)), \
             patch.object(validator, 'github_metadata', side_effect=OSError('offline')):
            self.assertEqual(adapter.main(), 1)

    def test_workflow_edited_and_aggregate_gate(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('ready_for_review, edited', workflow)
        self.assertIn('needs: [checks, shards, performance, live, production-proof]', workflow)
        self.assertIn('test "$PRODUCTION_PROOF" = success', workflow)

    def test_valid_edited_event_rechecks_metadata_after_admission(self):
        adapter = module()
        validator, contract = adapter.load_pinned(ROOT)
        event = {'action': 'edited', 'repository': {'full_name': 'jbookout/doctorcre-app'},
                 'pull_request': {'number': 1, 'body': BODY, 'base': {'sha': 'a' * 40}, 'head': {'sha': 'b' * 40}}}
        event_path = self.root / 'event.json'
        event_path.write_text(json.dumps(event))
        for responses, expected in [([{}, {}], 0), ([{}, ValueError('stale PR event')], 1)]:
            with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_EVENT_PATH': str(event_path)}), \
                 patch.object(sys, 'argv', [str(PROGRAM), '--root', str(self.root)]), \
                 patch.object(adapter, 'load_pinned', return_value=(validator, contract)), \
                 patch.object(validator, 'command', return_value='src/ui/example.tsx\0'), \
                 patch.object(validator, 'github_metadata', side_effect=responses) as metadata:
                self.assertEqual(adapter.main(), expected)
                self.assertEqual(metadata.call_count, 2)

    def test_real_aggregate_refuses_failed_admission_and_allows_main_skip(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        script = workflow.split('          test "$CHECKS" = success', 1)[1].split('\n\n  preview:', 1)[0]
        script = 'test "$CHECKS" = success' + script
        for event, proof, expected in [('pull_request', 'failure', 1),
                                       ('pull_request', 'success', 0), ('push', 'skipped', 0)]:
            settings = dict(os.environ, CHECKS='success', LIVE='success', SHARDS='success',
                            PERFORMANCE='success', EVENT=event, PRODUCTION_PROOF=proof)
            result = subprocess.run(['bash', '-e', '-c', script], env=settings, timeout=5)
            self.assertEqual(result.returncode, expected)


if __name__ == '__main__':
    unittest.main()
