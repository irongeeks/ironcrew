import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CiToolsTest(unittest.TestCase):
    def test_supported_platforms_are_pinned(self):
        tools = load('ci-tools')
        for system, architecture, expected in [('Darwin', 'arm64', 'darwin-arm64'),
                                               ('Darwin', 'x86_64', 'darwin-amd64'),
                                               ('Linux', 'x86_64', 'linux-amd64'),
                                               ('Linux', 'aarch64', 'linux-arm64'),
                                               ('Windows', 'AMD64', 'windows-amd64'),
                                               ('Windows', 'ARM64', 'windows-arm64')]:
            self.assertEqual(tools.target(system, architecture), expected)
            self.assertRegex(tools.DIGESTS[expected], r'^[a-f0-9]{64}$')
        with self.assertRaises(ValueError):
            tools.target('Linux', 'unrecognized')

    def test_corrupt_archive_is_rejected_before_creating_files(self):
        tools = load('ci-tools')
        with tempfile.TemporaryDirectory() as folder:
            destination = pathlib.Path(folder) / 'age'
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                tools.extract(b'not the official release', 'windows-amd64', destination)
            self.assertFalse(destination.exists())

    def test_windows_invokes_the_explicit_cmd_shim(self):
        verification = load('verify-local')
        with mock.patch.object(verification, 'os', SimpleNamespace(name='nt')):
            self.assertEqual(verification.pnpm_command(['audit', '--json']),
                             ['cmd.exe', '/d', '/c', 'npx.cmd', '--yes', 'pnpm@10.30.1', 'audit', '--json'])

    def test_missing_test_prerequisites_fail_before_gates(self):
        verification = load('verify-local')
        with mock.patch.dict(verification.os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'IRONCREW_TEST_AGE'):
                verification.require_test_tools()

    def test_no_skip_gate_counts_vitest_and_playwright(self):
        verification = load('verify-local')
        self.assertEqual(verification.test_counts(' Tests  19 passed | 2 skipped (21)'), (19, 2))
        self.assertEqual(verification.test_counts('  7 passed (20s)\n  1 skipped'), (7, 1))
        self.assertEqual(verification.test_counts('Tests  20 passed (20)'), (20, 0))
        self.assertEqual(verification.test_counts('No tests found'), (0, 0))

    def test_resume_accepts_only_the_same_verified_source_prefix(self):
        verification = load('verify-local')
        manifest = [{'path': 'apps/control/main.ts', 'sha256': 'original'}]
        fingerprint = verification.source_fingerprint(manifest)
        prior = {'sourceFingerprint': fingerprint,
                 'gates': [{'name': 'install', 'exitCode': 0}, {'name': 'format', 'exitCode': 1}]}
        self.assertEqual(verification.resume_prefix(prior, 1, fingerprint), prior['gates'][:1])
        with self.assertRaisesRegex(ValueError, 'successful earlier gate prefix'):
            verification.resume_prefix(prior, 2, fingerprint)
        changed = verification.source_fingerprint([{'path': 'apps/control/main.ts', 'sha256': 'changed'}])
        with self.assertRaisesRegex(ValueError, 'unchanged sources'):
            verification.resume_prefix(prior, 1, changed)
        with self.assertRaisesRegex(ValueError, 'unchanged sources'):
            verification.resume_prefix({'gates': prior['gates']}, 1, fingerprint)
        prior['sourceIntegrity'] = {'status': 'changed_during_run'}
        with self.assertRaisesRegex(ValueError, 'unchanged sources'):
            verification.resume_prefix(prior, 1, fingerprint)

    def test_relocated_evidence_links_resolve_to_the_actual_logs(self):
        verification = load('verify-local')
        with tempfile.TemporaryDirectory() as folder:
            verification.EVIDENCE = pathlib.Path(folder) / 'run'
            expected = verification.EVIDENCE / 'unit.log'
            actual = (verification.ROOT / verification.evidence_path('unit.log')).resolve()
            self.assertEqual(actual, expected.resolve())
            with mock.patch.object(verification.os.path, 'relpath', side_effect=ValueError('path is on mount D:')):
                self.assertEqual(verification.evidence_path('unit.log'), expected.as_posix())


if __name__ == '__main__':
    unittest.main()
