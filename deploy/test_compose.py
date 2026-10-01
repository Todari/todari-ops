"""Test deployment selection without Docker, credentials or remote access."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ComposeTests(unittest.TestCase):
    def run_helper(self, enabled='', failure='', *args):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fake = root / 'docker'
            fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[-2:] == ['config', '--environment']:
    print('SECRET=must-not-appear-in-output')
    print('CONTENT_ENABLED=' + os.environ['TEST_ENABLED'])
if os.environ['TEST_FAIL'] and os.environ['TEST_FAIL'] in args:
    sys.exit(17)
''')
            fake.chmod(0o755)
            log = root / 'calls.jsonl'
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       CALL_LOG=str(log), TEST_ENABLED=enabled, TEST_FAIL=failure)
            result = subprocess.run(['bash', str(ROOT / 'deploy/compose.sh'), *(args or ('deploy',))],
                                    env=env, capture_output=True, text=True)
            self.assertNotIn('must-not-appear', result.stdout + result.stderr)
            return result, [json.loads(line) for line in log.read_text().splitlines()]

    def test_disabled_keeps_default_runtime(self):
        for enabled in ('', 'false', '0'):
            result, calls = self.run_helper(enabled)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(calls), 3)
            self.assertTrue(all('docker-compose.content.yml' not in call for call in calls))

    def test_enabled_builds_and_checks_before_restart(self):
        for enabled in ('true', '1'):
            result, calls = self.run_helper(enabled)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(calls), 4)
            self.assertTrue(all('docker-compose.content.yml' in call for call in calls[1:]))
            self.assertIn('build', calls[1])
            self.assertIn('/app/deploy/content_preflight.py', calls[2])
            self.assertIn('up', calls[3])
            self.assertIn('.env.production', calls[0])

    def test_failed_config_build_or_preflight_never_restarts(self):
        for failure in ('config', 'build', 'run'):
            result, calls = self.run_helper('true', failure)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(all('up' not in call for call in calls))

    def test_invalid_flag_fails_closed(self):
        result, calls = self.run_helper('treu')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)

    def test_log_commands_keep_overlay(self):
        result, calls = self.run_helper('true', '', 'logs', '--tail=50', 'bot')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls[-1][-3:], ['logs', '--tail=50', 'bot'])
        self.assertIn('docker-compose.content.yml', calls[-1])


if __name__ == '__main__':
    unittest.main()
