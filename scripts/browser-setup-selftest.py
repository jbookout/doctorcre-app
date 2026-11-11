import importlib.util
import os
import signal
import sys
import tempfile
import time
import subprocess
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class BrowserSetupTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('browser_setup', Path(__file__).with_name('browser-setup.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def run_setup(self, probe, install=0):
        calls = []

        def run(command, **options):
            calls.append((command, options))
            return subprocess.CompletedProcess(command, probe if '--dry-run' in command else install)

        def popen(command, **options):
            calls.append((command, options))
            child = MagicMock()
            child.__enter__.return_value.wait.return_value = probe if '--dry-run' in command else 0
            return child

        with patch.object(self.module.subprocess, 'Popen', side_effect=popen), patch.object(self.module.subprocess, 'run', side_effect=run), patch.object(self.module.sys, 'platform', 'linux'):
            result = self.module.setup(['chromium', 'webkit'])
        return result, calls

    def test_preinstalled_packages_never_contact_apt(self):
        result, calls = self.run_setup(0)
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 2)
        self.assertFalse(any('sudo' in command for command, _ in calls))
        self.assertEqual(calls[-1][0][-3:], ['install', 'chromium', 'webkit'])
        self.assertNotIn('--with-deps', calls[-1][0])

    def test_missing_packages_get_one_bounded_install_before_browsers(self):
        result, calls = self.run_setup(1)
        self.assertEqual(result, 0)
        command = calls[1][0]
        self.assertEqual(command[:6], ['sudo', '-n', 'timeout', '--kill-after=5s', '115s', 'env'])
        self.assertIn('APT_CONFIG=', ' '.join(command))
        self.assertEqual(command[-3:], ['install-deps', 'chromium', 'webkit'])
        self.assertEqual(len(calls), 3)

    def test_mirror_deadline_and_errors_stop_before_browser_tests(self):
        for status in [100, 124, 137]:
            with self.subTest(status=status):
                result, calls = self.run_setup(1, status)
                self.assertNotEqual(result, 0)
                self.assertEqual(len(calls), 2)

    def test_probe_failure_is_not_treated_as_missing_packages(self):
        result, calls = self.run_setup(2)
        self.assertNotEqual(result, 0)
        self.assertEqual(len(calls), 1)

    def test_browser_download_failure_stops_setup(self):
        child = MagicMock()
        child.__enter__.return_value.wait.return_value = 1
        with patch.object(self.module.sys, 'platform', 'darwin'), patch.object(self.module.subprocess, 'Popen', return_value=child):
            self.assertNotEqual(self.module.setup(['chromium']), 0)

    def test_browser_timeout_kills_and_reaps_the_download_group(self):
        child = MagicMock()
        child.pid = 12345
        child.wait.side_effect = [subprocess.TimeoutExpired('download', 180), 0]
        process = MagicMock()
        process.__enter__.return_value = child
        with patch.object(self.module.sys, 'platform', 'darwin'), patch.object(self.module.subprocess, 'Popen', return_value=process), patch.object(self.module.os, 'killpg') as kill:
            self.assertNotEqual(self.module.setup(['chromium']), 0)
        kill.assert_called_once_with(12345, self.module.signal.SIGKILL)
        self.assertEqual(child.wait.call_count, 2)

    def test_probe_timeout_stops_setup(self):
        with tempfile.TemporaryDirectory(prefix='probe-timeout-') as directory:
            root = Path(directory)
            pid_file = root / 'apt.pid'
            apt = root / 'apt-get'
            apt.write_text(f'#!{sys.executable}\nimport os, pathlib, time\npathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))\ntime.sleep(60)\n')
            apt.chmod(0o755)
            node = root / 'node'
            node.write_text(f'#!{sys.executable}\nimport subprocess\nsubprocess.run([{str(apt)!r}])\n')
            node.chmod(0o755)
            pid = None
            try:
                with patch.dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH']), patch.object(self.module.sys, 'platform', 'linux'):
                    self.assertEqual(self.module.setup(['chromium']), 1)
                pid = int(pid_file.read_text())
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    status = Path(f'/proc/{pid}/stat')
                    if status.exists() and status.read_text().split()[2] == 'Z':
                        break
                    time.sleep(0.02)
                else:
                    self.fail(f'apt-get descendant {pid} survived the probe deadline')
            finally:
                if pid is None and pid_file.exists():
                    pid = int(pid_file.read_text())
                if pid is not None:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
