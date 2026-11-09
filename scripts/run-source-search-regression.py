"""Focused native search route / task permission / accumulated-budget acceptance.

Synthetic providers only; HTTPS CONNECT and namespace acceptance are separate
isolation maintenance fixtures, never real model calls in this collection.
"""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TESTS = ['source-search.test.mjs', 'source-search-proxy.test.mjs', 'managed-search.test.mjs']

if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME'), 'Isolated HOME required'
    raise SystemExit(subprocess.run(['node', '--test', *[str(ROOT / 'tests' / name) for name in TESTS]], cwd=ROOT).returncode)
