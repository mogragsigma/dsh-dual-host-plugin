"""R3 foundational contracts, NOT end-to-end R3 acceptance. Use bin/isolated."""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME'), 'Isolated HOME required'
    subprocess.run(['python3', str(ROOT / 'scripts/build-module-index.py'), '--check'], check=True)
    raise SystemExit(subprocess.run(['node', '--test', str(ROOT / 'tests/managed-runtime.test.mjs')], cwd=ROOT).returncode)
