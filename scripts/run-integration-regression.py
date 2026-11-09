"""R1-R5 integration and exact 0.33.4 transition fixtures; isolated only."""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME')
    assert os.environ.get('BASELINE_BUNDLE') and os.environ.get('TRANSITION_INSPECTOR')
    subprocess.run(['python3', str(ROOT / 'scripts/build-module-index.py'), '--check'], check=True)
    raise SystemExit(subprocess.run(['node', '--test', str(ROOT / 'tests/integration-transition.test.mjs')], cwd=ROOT).returncode)
