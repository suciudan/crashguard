"""Deployment control-flow tests; no Docker daemon or production data is used."""

import fcntl
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'deploy.sh'
IMAGE = 'ghcr.io/suciudan/crashguard@sha256:' + 'a' * 64


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='crashguard deploy ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / '.env.production').write_text('')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import sys
args = sys.argv[1:]
with open(os.environ['DOCKER_CALLS'], 'a') as log:
    log.write(' '.join(args) + '\\n')
if args[-1] == 'config':
    print('services: {crashguard: {image: candidate}}')
if os.environ.get('FAIL_PULL') and args[-1] == 'pull':
    sys.exit(1)
if os.environ.get('FAIL_HEALTH') and 'up' in args:
    sys.exit(1)
''')
        docker.chmod(0o700)
        self.env = {
            **os.environ,
            'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'CRASHGUARD_DEPLOY_DIR': str(self.root),
            'CRASHGUARD_IMAGE': IMAGE,
            'NEXT_PUBLIC_APP_URL': 'https://crashguard.example.com',
            'DOCKER_CALLS': str(self.root / 'docker.log'),
            'CRASHGUARD_NATIVE': '0',
        }

    def run_deploy(self, **env):
        return subprocess.run(
            ['bash', str(SCRIPT)], env={**self.env, **env},
            capture_output=True, text=True, timeout=15,
        )

    def calls(self):
        path = self.root / 'docker.log'
        return path.read_text() if path.exists() else ''

    def test_first_deployment(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('First deployment', result.stdout)
        self.assertEqual((self.root / 'current-image').read_text().strip(), IMAGE)
        self.assertTrue((self.root / 'compose.yaml').exists())
        self.assertFalse((self.root / 'compose.candidate.yaml').exists())
        self.assertIn('--wait --wait-timeout 120', self.calls())

    def test_backup_includes_live_wal_and_previous_configuration(self):
        db = sqlite3.connect(self.root / 'data' / 'crashguard.sqlite')
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE events (message TEXT)')
        db.execute("INSERT INTO events VALUES ('persist me')")
        db.commit()
        (self.root / 'compose.yaml').write_text('previous configuration')
        self.assertTrue((self.root / 'data' / 'crashguard.sqlite-wal').exists())
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        backup = next((self.root / 'backups').glob('*/crashguard.sqlite'))
        with sqlite3.connect(backup) as saved:
            self.assertEqual(saved.execute('SELECT message FROM events').fetchone(), ('persist me',))
        self.assertEqual(backup.with_name('compose.yaml').read_text(), 'previous configuration')

    def test_pull_failure_does_not_replace_running_configuration(self):
        (self.root / 'compose.yaml').write_text('previous')
        result = self.run_deploy(FAIL_PULL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(' up ', self.calls())
        self.assertFalse((self.root / 'backups').exists())
        self.assertEqual((self.root / 'compose.yaml').read_text(), 'previous')

    def test_backup_failure_prevents_container_replacement(self):
        (self.root / 'data' / 'crashguard.sqlite').write_bytes(b'not a database')
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(' up ', self.calls())

    def test_health_failure_preserves_previous_state(self):
        (self.root / 'compose.yaml').write_text('previous')
        (self.root / 'current-image').write_text('previous image')
        result = self.run_deploy(FAIL_HEALTH='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Deployment failed', result.stderr)
        self.assertEqual((self.root / 'compose.yaml').read_text(), 'previous')
        self.assertEqual((self.root / 'current-image').read_text(), 'previous image')
        self.assertTrue((self.root / 'compose.candidate.yaml').exists())

    def test_mutable_image_is_rejected(self):
        result = self.run_deploy(CRASHGUARD_IMAGE='ghcr.io/suciudan/crashguard:latest')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), '')

    def test_lock_prevents_overlapping_deployments(self):
        with (self.root / 'deploy.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another deployment', result.stderr)
        self.assertEqual(self.calls(), '')

    def test_native_override(self):
        result = self.run_deploy(CRASHGUARD_NATIVE='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('compose.native.yaml', self.calls())


if __name__ == '__main__':
    unittest.main()
