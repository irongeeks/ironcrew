"""Run the local release gates and retain their actual, reproducible evidence."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import platform
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/test-evidence'
COMMANDS = [
    ('install', ['install', '--frozen-lockfile']),
    ('format', ['format:check']),
    ('lint', ['lint']),
    ('typecheck', ['typecheck']),
    ('unit', ['test:unit']),
    ('contracts', ['test:contracts']),
    ('integration', ['test:integration']),
    ('build', ['build']),
    ('e2e', ['test:e2e']),
    ('recovery', ['test:recovery']),
    ('install-tests', ['test:install']),
    ('openapi', ['openapi:check']),
]
TEST_GATES = {'unit', 'contracts', 'integration', 'e2e', 'recovery', 'install-tests'}


def source_manifest():
    excluded = {'node_modules', 'dist', '.var', '__pycache__', 'evidence',
                'test-results', 'playwright-report'}
    files = [p for directory in ('apps', 'packages', 'scripts', 'tests')
             for p in (ROOT / directory).rglob('*')
             if p.is_file() and not excluded.intersection(p.relative_to(ROOT).parts)
             and not p.name.endswith('.tsbuildinfo')]
    files += [ROOT / name for name in (
        '.gitignore', '.prettierignore', 'LICENSE', 'package.json', 'pnpm-lock.yaml',
        'pnpm-workspace.yaml', 'eslint.config.mjs', 'tsconfig.json',
        'tsconfig.build.json', 'playwright.config.ts', 'vitest.config.ts')]
    return [{'path': str(p.relative_to(ROOT)),
             'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in sorted(set(files))]


def write_json(filename, value):
    (EVIDENCE / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def source_fingerprint(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode('utf8')).hexdigest()


def resume_prefix(prior, start, fingerprint):
    if prior.get('sourceFingerprint') != fingerprint or prior.get('sourceIntegrity', {}).get('status') == 'changed_during_run':
        raise ValueError('Resume requires unchanged sources bound to the earlier run; start a full verification.')
    prefix = [name for name, _ in COMMANDS[:start]]
    gates = [gate for gate in prior['gates'] if gate['name'] in prefix]
    if [gate['name'] for gate in gates] != prefix or any(gate['exitCode'] for gate in gates):
        raise ValueError('Resume requires a complete successful earlier gate prefix.')
    return gates


def evidence_path(filename):
    file = EVIDENCE / filename
    try:
        return pathlib.Path(os.path.relpath(file, ROOT)).as_posix()
    except ValueError:
        # Windows cannot express a relative path across drive letters.
        return file.as_posix()


def pnpm_command(arguments):
    command = ['npx', '--yes', 'pnpm@10.30.1'] + arguments
    # Windows cannot execute a .cmd shim with CreateProcess directly.
    if os.name == 'nt':
        return ['cmd.exe', '/d', '/c', 'npx.cmd'] + command[1:]
    return command


def test_counts(output):
    output = re.sub(r'\x1b\[[0-9;]*m', '', output)
    match = re.search(r'(?:Tests\s+|^\s*)(\d+) passed', output, re.MULTILINE)
    skipped = re.findall(r'(\d+) (?:skipped|pending)', output)
    return int(match.group(1)) if match else 0, max(map(int, skipped), default=0)


def require_test_tools():
    for name, expected in [('AGE', '1.3.2'), ('AGE_KEYGEN', '1.3.2'), ('NODE', '26.4.0')]:
        file = os.environ.get('IRONCREW_TEST_' + name)
        if not file or not pathlib.Path(file).is_absolute() or not pathlib.Path(file).is_file():
            raise RuntimeError('IRONCREW_TEST_' + name + ' must name an existing absolute executable')
        actual = subprocess.check_output([file, '--version'], text=True).strip().removeprefix('v')
        if actual != expected:
            raise RuntimeError('IRONCREW_TEST_' + name + ' version mismatch: ' + actual)


def main():
    global EVIDENCE
    # Preserve diagnostics on Windows hosts whose default console encoding is cp1252.
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-tools', action='store_true', help='Fail before gates when any native test prerequisite is missing')
    parser.add_argument('--evidence-dir', type=pathlib.Path, default=EVIDENCE,
                        help='Directory for this run; defaults to docs/test-evidence')
    parser.add_argument('resume', nargs='?', choices=[name for name, _ in COMMANDS])
    args = parser.parse_args()
    if args.require_tools:
        require_test_tools()
    EVIDENCE = args.evidence_dir.resolve()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    initial_sources = source_manifest()
    report = {
        'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip(),
        'workspace': 'GitHub Actions checkout' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'local next/ working tree; exact files recorded in sourceIntegrity',
        'platform': platform.platform(),
        'node': subprocess.check_output(['node', '--version'], text=True).strip(),
        'pnpm': '10.30.1', 'gates': [],
        'sourceFingerprint': source_fingerprint(initial_sources),
        'live': {'status': 'not_run', 'reason': 'No provider test profile or paid test budget supplied.'},
        'osMatrix': ('This report covers only the named GitHub Actions matrix host, not other operating systems or customer installations.' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'This suite runs on the named local host. Separate real Linux VM evidence is recorded under docs/test-evidence/isolation. Remote GitHub CI and the remaining OS installation matrix are not covered.'),
    }
    commands = COMMANDS
    if args.resume:
        start = next(i for i, (name, _) in enumerate(COMMANDS) if name == args.resume)
        prior = json.loads((EVIDENCE / 'gates.json').read_text(encoding='utf8'))
        try:
            report['gates'] = resume_prefix(prior, start, report['sourceFingerprint'])
        except ValueError as error:
            parser.error(str(error))
        # Make mixed-run evidence explicit, rather than claiming the prefix was rerun.
        report['resumedFrom'] = {'gate': args.resume, 'priorRunDate': prior['date']}
        commands = COMMANDS[start:]
    environment = dict(os.environ, NO_COLOR='1')
    environment.pop('FORCE_COLOR', None)
    for name, arguments in commands:
        print('START ' + name, flush=True)
        started = time.monotonic()
        command = pnpm_command(arguments)
        result = subprocess.run(command, cwd=ROOT, env=environment, text=True, encoding='utf8', errors='replace',
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (EVIDENCE / (name + '.log')).write_text(result.stdout, encoding='utf8')
        gate = {'name': name, 'command': ' '.join(command), 'exitCode': result.returncode,
                'durationSeconds': round(time.monotonic() - started, 2),
                'log': evidence_path(name + '.log')}
        if name in TEST_GATES:
            gate['passedTests'], gate['skippedTests'] = test_counts(result.stdout)
            if result.returncode == 0 and (not gate['passedTests'] or gate['skippedTests']):
                gate['exitCode'] = 1
                gate['failureReason'] = 'A release gate must execute its tests without skips.'
        report['gates'].append(gate)
        write_json('gates.json', report)
        print(('PASS ' if gate['exitCode'] == 0 else 'FAIL ') + name, flush=True)
        if gate['exitCode']:
            print(result.stdout[-7000:], flush=True)
            return gate['exitCode']
    audit = subprocess.run(pnpm_command(['audit', '--json']),
                           cwd=ROOT, text=True, encoding='utf8', errors='replace', stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (EVIDENCE / 'audit.json').write_text(audit.stdout, encoding='utf8')
    audit_exit = audit.returncode
    try:
        vulnerabilities = json.loads(audit.stdout)['metadata']['vulnerabilities']
        if set(vulnerabilities) != {'info', 'low', 'moderate', 'high', 'critical'} or any(vulnerabilities.values()):
            audit_exit = audit_exit or 1
    except (ValueError, KeyError, TypeError):
        audit_exit = audit_exit or 1
    report['audit'] = {'exitCode': audit_exit, 'log': evidence_path('audit.json')}
    final_sources = source_manifest()
    if final_sources != initial_sources:
        report['sourceIntegrity'] = {'status': 'changed_during_run'}
        write_json('gates.json', report)
        print('FAIL source changed during verification; rerun against stable sources.', flush=True)
        return 1
    write_json('source-manifest.json', final_sources)
    report['sourceIntegrity'] = {
        'status': 'stable', 'fileCount': len(final_sources),
        'manifestSha256': hashlib.sha256((EVIDENCE / 'source-manifest.json').read_bytes()).hexdigest(),
    }
    report['passedTests'] = sum(g.get('passedTests', 0) for g in report['gates'])
    write_json('gates.json', report)
    print('AUDIT ' + str(audit_exit), flush=True)
    return audit_exit


if __name__ == '__main__':
    sys.exit(main())
