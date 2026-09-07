"""Pinned age tools for release gates; downloads only into a private runner directory."""
import argparse
import hashlib
import io
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

VERSION = '1.3.2'
SOURCE = 'https://github.com/FiloSottile/age/releases/tag/v1.3.2'
# Official GitHub release asset digests, independently pinned on 2026-09-07.
DIGESTS = {
    'darwin-amd64': '1d1e4bc66e1427edad7739ae7616157de0e79db8b6d2a1497d7d9925fb06a539',
    'darwin-arm64': 'e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5',
    'linux-amd64': 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10',
    'linux-arm64': '6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4',
    'windows-amd64': 'f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7',
    'windows-arm64': 'fae351336c8d5f30f93cc3ccdec16d1ed7851d68cdd6656d41955cc31a447c9d',
}
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXECUTABLE = 20 * 1024 * 1024


def target(system=None, machine=None):
    system = (system or platform.system()).lower()
    architecture = (machine or platform.machine()).lower()
    architecture = {'x86_64': 'amd64', 'x64': 'amd64', 'aarch64': 'arm64'}.get(architecture, architecture)
    value = system + '-' + architecture
    if value not in DIGESTS:
        raise ValueError('Unsupported age CI platform: ' + value)
    return value


def extract(archive, selected, destination):
    """Verify the complete archive before reading exactly two known regular files."""
    if len(archive) > MAX_ARCHIVE or hashlib.sha256(archive).hexdigest() != DIGESTS[selected]:
        raise ValueError('age archive SHA-256 mismatch')
    suffix = '.exe' if selected.startswith('windows-') else ''
    binaries = {}
    if suffix:
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            for name in ('age', 'age-keygen'):
                member = package.getinfo('age/' + name + suffix)
                if member.is_dir() or member.file_size > MAX_EXECUTABLE:
                    raise ValueError('Invalid age executable member')
                binaries[name] = package.read(member)
    else:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            for name in ('age', 'age-keygen'):
                member = package.getmember('age/' + name)
                if not member.isfile() or member.size > MAX_EXECUTABLE:
                    raise ValueError('Invalid age executable member')
                binaries[name] = package.extractfile(member).read()
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    paths = {}
    for name, content in binaries.items():
        file = destination / (name + suffix)
        with file.open('xb') as output:
            output.write(content)
        file.chmod(0o755)
        paths[name] = str(file.resolve())
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--github-env', type=pathlib.Path)
    args = parser.parse_args()
    selected = target()
    extension = 'zip' if selected.startswith('windows-') else 'tar.gz'
    asset = f'age-v{VERSION}-{selected}.{extension}'
    url = f'https://github.com/FiloSottile/age/releases/download/v{VERSION}/{asset}'
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read(MAX_ARCHIVE + 1)
    paths = extract(archive, selected, args.directory.resolve())
    node = pathlib.Path(shutil.which('node') or '').resolve()
    if not node.is_file() or subprocess.check_output([str(node), '--version'], text=True).strip() != 'v26.4.0':
        raise ValueError('Node 26.4.0 from actions/setup-node is required')
    for executable in paths.values():
        version = subprocess.check_output([executable, '--version'], text=True).strip().removeprefix('v')
        if version != VERSION:
            raise ValueError('age executable version mismatch')
    environment = {'IRONCREW_TEST_AGE': paths['age'], 'IRONCREW_TEST_AGE_KEYGEN': paths['age-keygen'],
                   'IRONCREW_TEST_NODE': str(node)}
    evidence = {'source': SOURCE, 'asset': asset, 'archiveSha256': DIGESTS[selected],
                'platform': selected, 'nodeVersion': '26.4.0',
                'binarySha256': {key: hashlib.sha256(pathlib.Path(value).read_bytes()).hexdigest()
                                 for key, value in environment.items()}}
    (args.directory / 'ci-tools.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if args.github_env:
        with args.github_env.open('a', encoding='utf8') as output:
            for key, value in environment.items():
                if '\n' in value or '\r' in value:
                    raise ValueError('Invalid CI environment path')
                output.write(key + '=' + value + '\n')
    print(json.dumps({'environment': environment, 'evidence': evidence}, indent=2))


if __name__ == '__main__':
    main()
