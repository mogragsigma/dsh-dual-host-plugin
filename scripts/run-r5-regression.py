"""R5 native CLI/task agreement, real Git facts and immutable artifact lifecycle."""
from pathlib import Path
import os
import subprocess
ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME'), 'Isolated HOME required'
    subprocess.run(['python3', str(ROOT / 'scripts/build-module-index.py'), '--check'], check=True)
    tests = ['managed-development.test.mjs', 'managed-artifacts.test.mjs', 'managed-delivery.test.mjs', 'managed-development-ui.test.mjs']
    raise SystemExit(subprocess.run(['node', '--test', *[str(ROOT / 'tests' / f) for f in tests]], cwd=ROOT).returncode)
