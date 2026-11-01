"""Current R0 acceptance, synthetic only. Run through an isolated launcher.

Frozen release-promotion / market-v0331 tests are deliberately NOT current
contracts. Their negative lock/identity cases live in market-current.
"""
from pathlib import Path
import argparse
import os
import re
import runpy
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TESTS = sorted(set(
    runpy.run_path(str(ROOT / 'scripts/run-market-regression.py'))['TESTS']
    + runpy.run_path(str(ROOT / 'scripts/run-onboarding-regression.py'))['TESTS']
    + ['release-current', 'onboarding-optional-im', 'cloud-control',
       'cloud-operation', 'cloud-runtime', 'onboarding-runtime-version',
       'onboarding-self-stop', 'self-stop-flow', 'self-lifecycle-flow-contract']
))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shard', help='Node test file shard i/n; all shards are required for acceptance')
    args = parser.parse_args()
    shard = []
    if args.shard:
        assert re.fullmatch(r'[1-9][0-9]*/[1-9][0-9]*', args.shard)
        index, total = map(int, args.shard.split('/'))
        assert index <= total
        shard = ['--test-shard=' + args.shard]
    subprocess.run(['python3', str(ROOT / 'scripts/build-module-index.py'), '--check'], check=True)
    with tempfile.TemporaryDirectory(prefix='dsh-current-release-') as tmp:
        home = Path(tmp) / 'home'
        home.mkdir(mode=0o700)
        env = dict(os.environ, HOME=str(home), DSH_HOME=str(home / '.dsh'),
                   DSH_AGENTS_HOME=str(home / '.agents'), TMPDIR=tmp)
        previous = os.umask(0o022)
        try:
            result = subprocess.run([os.environ.get('NODE', 'node'), '--test',
                '--test-concurrency=2', *shard,
                *[str(ROOT / 'tests' / (name + '.test.mjs')) for name in TESTS]],
                cwd=ROOT, env=env)
        finally:
            os.umask(previous)
        raise SystemExit(result.returncode)
