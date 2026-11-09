"""Offline restoration against real Gateway storage, synthetic isolated fixtures only."""
from pathlib import Path
import os
import subprocess
ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME') and os.environ.get('OFFLINE_RESTORE_TOOL')
    subprocess.run(['python3', str(ROOT/'scripts/build-module-index.py'), '--check'], check=True)
    raise SystemExit(subprocess.run(['node', '--test', str(ROOT/'tests/offline-artifact-restore.test.mjs')], cwd=ROOT).returncode)
