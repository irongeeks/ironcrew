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


if __name__ == '__main__':
    unittest.main()
