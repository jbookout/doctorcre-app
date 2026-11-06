import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('results', ROOT / 'scripts/browser-results.py')
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)


class ResultsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'test').mkdir()
        self.files = sorted({s.split('::')[0] for s in results.CRITICAL})
        self.assertEqual(len(results.CRITICAL), 23)

    def produce(self, change=None):
        for file in self.files:
            names = [s.split('::', 1)[1] for s in results.CRITICAL if s.startswith(file + '::')]
            source = "import test, {describe} from 'node:test';\n" + f"describe({json.dumps(file)},()=>{{\n"
            for name in names:
                parent, _, child = name.partition('::')
                body = f"test({json.dumps(parent)}, async t => {{await t.test({json.dumps(child)},()=>{{}});}});" if child else f"test({json.dumps(name)},()=>{{}});"
                source += (change(body) if change else body) + '\n'
            (self.root / file).write_text(source + '\n});\n')

    def run_node(self, shard, timeout=60):
        output = self.root / f'{shard}.xml'
        env = dict(os.environ)
        env.pop('NODE_TEST_CONTEXT', None)
        run = subprocess.run(['node', '--test', f'--test-shard={shard}/4', '--test-concurrency=2',
                              '--test-timeout=180000', '--test-reporter=junit',
                              f'--test-reporter-destination={output}', *self.files],
                             cwd=self.root, env=env, capture_output=True, timeout=timeout)
        return run, output

    def test_native_pass_and_nested_identity_all_23_once(self):
        self.produce()
        for shard in range(1, 5):
            run, output = self.run_node(shard)
            self.assertEqual(run.returncode, 0, run.stderr)
            results.verify(output, self.files, shard)

    def test_native_skipped_failed_omitted_duplicate_and_interrupted_critical(self):
        changes = {
            'skip': lambda s: s.replace(',()=>{}', ',{skip:true},()=>{}'),
            'failure': lambda s: s.replace('()=>{}', "()=>{throw Error('seeded')}"),
            'omission': lambda s: '',
            'duplicate': lambda s: s + s,
            'interrupted': lambda s: s.replace('()=>{}', ',{timeout:10},async()=>new Promise(()=>{})').replace(',,', ','),
        }
        for name, change in changes.items():
            with self.subTest(name=name):
                self.produce(change)
                _, output = self.run_node(1)
                with self.assertRaises(ValueError):
                    results.verify(output, self.files, 1)

    def test_same_case_name_in_another_file_cannot_replace_critical_identity(self):
        self.produce()
        file = self.root / self.files[0]
        file.write_text(file.read_text().replace(self.files[0], 'test/other.test.mjs'))
        _, output = self.run_node(1)
        with self.assertRaises(ValueError):
            results.verify(output, self.files, 1)

    def test_missing_truncated_empty_and_deleted_file_refused(self):
        output = self.root / '1.xml'
        with self.assertRaises(OSError):
            results.verify(output, self.files, 1)
        self.produce()
        _, output = self.run_node(1)
        native = output.read_text()
        for data in [native[:-30], '<?xml version="1.0"?><testsuites/>']:
            output.write_text(data)
            with self.assertRaises((ValueError, results.ET.ParseError)):
                results.verify(output, self.files, 1)
        output.write_text(native)
        with self.assertRaises(ValueError):
            results.verify(output, self.files[1:], 1)

    def test_early_failure_later_pass_and_killed_runner_remain_red(self):
        self.produce(lambda s: s + "test('later pass',()=>{});" if 'authentication loss' in s else s)
        file = self.root / self.files[-1]
        file.write_text(file.read_text().replace('()=>{}', "()=>{throw Error('early')} ", 1))
        run, _ = self.run_node(4)
        self.assertNotEqual(run.returncode, 0)
        self.produce(lambda s: s.replace('()=>{}', '()=>{process.kill(process.pid,"SIGKILL")}'))
        run, output = self.run_node(1)
        self.assertNotEqual(run.returncode, 0)
        with self.assertRaises(ValueError):
            results.verify(output, self.files, 1)

    def test_killed_shard_cannot_supply_complete_report(self):
        self.produce(lambda s: s.replace('()=>{}', '()=>{process.kill(process.ppid,"SIGKILL")}'))
        run, output = self.run_node(1)
        self.assertNotEqual(run.returncode, 0)
        with self.assertRaises((OSError, ValueError, results.ET.ParseError)):
            results.verify(output, self.files, 1)

    def test_native_shards_partition_working_tree_inventory_once(self):
        self.files = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'test').glob('*.test.mjs'))
        for file in self.files:
            (self.root / file).write_text("import test from 'node:test'; test(" + json.dumps(file) + ",()=>{});")
        union = []
        for shard in range(1, 5):
            run, output = self.run_node(shard)
            self.assertEqual(run.returncode, 0, run.stderr)
            names = [e.get('name') for e in results.ET.parse(output).iter('testcase')]
            self.assertEqual(names, self.files[shard - 1::4])
            union.extend(names)
        self.assertEqual(sorted(union), self.files)
        self.assertEqual(len(set(union)), len(union))
        print(f'native partition: {len(union)} files, no duplicates')

    def test_first_attempt_proof_requires_only_produced_native_evidence(self):
        plan = json.loads((ROOT / 'proofs/requirements/wr617-s1-ci-first-attempt-evidence.json').read_text())
        observation = next(a for a in plan['assertions'] if a['id'] == 'main-first-attempt-evidence-retained')
        requirement = json.dumps(observation)
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        unsupported = []
        for obsolete, producer in [('browser-coverage', 'name: browser-coverage'),
                                   ('planned manifests', 'planned'), ('start/exit evidence', 'started'),
                                   ('per-file JUnit', 'per-file')]:
            required, produced = obsolete in requirement, producer in workflow
            print(f'{obsolete}: required={required} produced={produced}')
            if required and not produced:
                unsupported.append(obsolete)
        self.assertEqual(unsupported, [], 'proof requires deleted evidence')
        self.assertIn('per-shard native JUnit XML', requirement)
        self.assertIn('required test aggregate', requirement)
        self.assertIn('out/browser-results/junit.xml', workflow)
        self.assertIn('retention-days: 14', workflow)
        self.assertIn('needs: [checks, shards, performance, live]', workflow)

    def test_required_aggregate_accepts_only_native_success_including_retained_shards(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        shell = workflow.split('      - name: Require all applicable jobs to pass')[1].split('        run: |\n')[1].split('\n  preview:')[0]
        shell = '\n'.join(line[10:] for line in shell.splitlines())
        env = dict(CHECKS='success', LIVE='success', SHARDS='success', PERFORMANCE='success')
        self.assertEqual(subprocess.run(['bash', '-e', '-c', shell], env=env).returncode, 0)
        for job in env:
            for state in ['failure', 'cancelled', 'skipped', '']:
                self.assertNotEqual(subprocess.run(['bash', '-e', '-c', shell], env={**env, job: state}).returncode, 0)


if __name__ == '__main__':
    unittest.main()
