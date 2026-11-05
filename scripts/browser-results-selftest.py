import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / 'scripts/browser-results.py'
spec = importlib.util.spec_from_file_location('results', PROGRAM)
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)
FIXTURES = ROOT / 'test/fixtures/browser-results'


class ResultsTest(unittest.TestCase):
    def test_native_outcomes_and_nested_identity(self):
        rows, complete = results.parse_junit((FIXTURES / 'outcomes.xml').read_text())
        self.assertTrue(complete)
        self.assertEqual([r['status'] for r in rows], ['pass', 'skip', 'fail', 'cancelled'])
        self.assertEqual(rows[-1]['scenario_id'], 'test/demo-browser.test.mjs::parent::cancelled')

    def test_partial_output_keeps_completed_receipts(self):
        rows, complete = results.parse_junit('<testsuites><testcase name="done" file="test/demo-browser.test.mjs"/><testcase')
        self.assertFalse(complete)
        self.assertEqual(rows[0]['status'], 'pass')

    def reports(self):
        reports = [dict(schema='browser-results.v1', sha='a'*40, run_id='42', attempt=1,
                        shard=str(n), job_status='success', complete=True, receipts=[])
                   for n in range(1, 5)]
        reports[0]['receipts'] = [dict(scenario_id=s, status='pass') for s in results.CRITICAL]
        return reports

    def test_coverage_never_accepts_missing_duplicate_or_unsuccessful(self):
        self.assertEqual(results.verify(self.reports(), 'a'*40, '42', 1), [])
        for status in ['fail', 'skip', 'cancelled', 'never-executed']:
            reports = self.reports()
            reports[0]['receipts'][0]['status'] = status
            self.assertTrue(results.verify(reports, 'a'*40, '42', 1), status)
        for mutate in [lambda r: r.pop(), lambda r: r.append(r[0]),
                       lambda r: r[0]['receipts'].pop(),
                       lambda r: r[0]['receipts'].append(r[0]['receipts'][0]),
                       lambda r: r[0].update(attempt=2),
                       lambda r: r[0].update(sha='b'*40),
                       lambda r: r[0].update(complete=False),
                       lambda r: r[0].update(job_status='cancelled')]:
            reports = self.reports()
            mutate(reports)
            self.assertTrue(results.verify(reports, 'a'*40, '42', 1))

    def test_shards_partition_the_full_suite_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'test').mkdir()
            for n in range(9):
                (root / f'test/{n}.test.mjs').write_text("import test from 'node:test'; test('pass',()=>{});")
            planned = []
            for shard in range(1, 5):
                output = root / str(shard)
                run = subprocess.run(['python3', str(PROGRAM), 'run', '--input', str(output), '--shard', str(shard)],
                                     cwd=root, capture_output=True)
                self.assertEqual(run.returncode, 0)
                repeat = subprocess.run(['python3', str(PROGRAM), 'run', '--input', str(output), '--shard', str(shard)],
                                        cwd=root, capture_output=True)
                self.assertNotEqual(repeat.returncode, 0)
                planned.extend(json.loads((output / 'planned.json').read_text()))
                rows, complete = results.collect(output)
                self.assertTrue(complete)
                self.assertTrue(all(r['status'] == 'pass' for r in rows))
            self.assertEqual(sorted(planned), [f'test/{n}.test.mjs' for n in range(9)])

    def test_real_node_reporter_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'native.test.mjs'
            file.write_text("import test from 'node:test'; test('pass',()=>{}); test('skip',{skip:true},()=>{}); test('fail',()=>{throw Error('intentional')}); test('cancel',{timeout:20},async()=>new Promise(()=>{}));")
            run = subprocess.run(['node', '--test', '--test-reporter=junit', str(file)],
                                 capture_output=True, text=True, timeout=5)
            rows, complete = results.parse_junit(run.stdout, 'test/native.test.mjs')
            self.assertTrue(complete, run.stdout)
            self.assertEqual([r['status'] for r in rows], ['pass', 'skip', 'fail', 'cancelled'])

    def test_native_failing_critical_test_keeps_required_gate_red(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'test').mkdir()
            name = 'test/inbox-freshness-feedback-browser.test.mjs'
            scenario = 'authentication loss during a refresh retires all private cards'
            (root / name).write_text("import test from 'node:test'; test(" + json.dumps(scenario) + ", () => {throw Error('intentional critical failure')});")
            for i in range(4):
                (root / f'test/z{i}.test.mjs').write_text("import test from 'node:test'; test('later file',()=>{});")
            output = root / 'results'
            run = subprocess.run(['python3', str(PROGRAM), 'run', '--input', str(output), '--shard', '1'],
                                 cwd=root, capture_output=True, text=True)
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            rows, complete = results.collect(output)
            self.assertTrue(complete)
            self.assertIn(dict(scenario_id=name + '::' + scenario, status='fail'), rows)
            self.assertIn(dict(scenario_id='test/z3.test.mjs::later file', status='pass'), rows)
            shell = (ROOT / '.github/workflows/ci.yml').read_text().split('      - name: Require all applicable jobs to pass')[1].split('        run: |\n')[1].split('\n  preview:')[0]
            shell = '\n'.join(line[10:] for line in shell.splitlines())
            for event in ['push', 'pull_request']:
                import os
                gate = subprocess.run(['bash', '-e', '-c', shell], capture_output=True,
                                      env={**os.environ, 'CHECKS':'success', 'LIVE':'success',
                                           'SHARDS':'failure', 'PERFORMANCE':'success', 'JOURNEYS':'success',
                                           'PRODUCTION_PROOF':'success', 'EVENT':event})
                self.assertNotEqual(gate.returncode, 0)

    def test_planned_unstarted_and_interrupted_files_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'planned.json').write_text(json.dumps(['test/never.test.mjs', 'test/interrupted.test.mjs']))
            (root / 'interrupted.test.started').touch()
            rows, complete = results.collect(root)
            self.assertFalse(complete)
            self.assertEqual([r['status'] for r in rows], ['never-executed', 'cancelled'])

    def test_cli_missing_output_is_visible_nonexecution(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'receipt.json'
            run = subprocess.run(['python3', str(PROGRAM), 'collect', '--input', str(output.with_suffix('.xml')),
                                  '--output', str(output), '--sha', 'a'*40, '--run-id', '42',
                                  '--attempt', '1', '--shard', '1', '--job-status', 'cancelled'], capture_output=True)
            self.assertEqual(run.returncode, 1)
            report = json.loads(output.read_text())
            self.assertEqual(report['job_status'], 'cancelled')
            self.assertFalse(report['complete'])
            gate = subprocess.run(['python3', str(PROGRAM), 'verify', '--input', directory,
                                   '--output', str(Path(directory) / 'coverage.json'), '--sha', 'a'*40,
                                   '--run-id', '42', '--attempt', '1'], capture_output=True)
            self.assertEqual(gate.returncode, 1)
            coverage = json.loads((Path(directory) / 'coverage.json').read_text())
            self.assertTrue(all(r['status'] == 'never-executed' for r in coverage['critical']))


if __name__ == '__main__':
    unittest.main()
