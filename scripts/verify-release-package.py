"""Verify exact root-package bytes against this source tree; never extracts tar.

npm omits the root package-lock.json, but preserves the nested bundle lock.
distribution-lock.json also supports older bundle-root distribution layouts;
cloudPackage restores the canonical name in the payload only when absent.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def verify(tarball):
    expected = {'package.json', 'README.md', 'LICENSE', 'LICENSE.en.md',
                'cordis.patch.yml', 'compatibility.json'}
    for p in (ROOT / 'bundle').rglob('*'):
        rel = p.relative_to(ROOT)
        if {'node_modules', 'private'} & set(rel.parts):
            continue
        assert not p.is_symlink(), f'linked product file: {rel}'
        if p.is_file():
            expected.add(rel.as_posix())
    actual = {}
    with tarfile.open(tarball) as archive:
        for entry in archive:
            assert entry.isfile(), f'non-file in package: {entry.name}'
            parts = PurePosixPath(entry.name).parts
            assert parts[0] == 'package' and '..' not in parts
            name = '/'.join(parts[1:])
            assert name in expected and name not in actual, name
            data = archive.extractfile(entry).read()
            assert data == (ROOT / name).read_bytes(), f'package/source drift: {name}'
            actual[name] = hashlib.sha256(data).hexdigest()
    assert set(actual) == expected, sorted(expected - set(actual))
    assert (ROOT / 'bundle/distribution-lock.json').read_bytes() == (ROOT / 'bundle/package-lock.json').read_bytes()
    return {'version': json.loads((ROOT / 'package.json').read_text())['version'],
            'sha256': hashlib.sha256(Path(tarball).read_bytes()).hexdigest(),
            'files': actual, 'file_count': len(actual), 'exact_source_match': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tarball')
    args = parser.parse_args()
    print(json.dumps(verify(args.tarball), ensure_ascii=False, indent=2))
