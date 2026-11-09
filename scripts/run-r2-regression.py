"""R2 single-user continuity regression. Synthetic adapters; run through bin/isolated."""
from pathlib import Path
import os
import subprocess
ROOT = Path(__file__).resolve().parents[1]
TESTS = ['task-continuity', 'task-native-decisions', 'task-native-ui', 'source-intake', 'source-intake-process', 'source-intake-lifecycle',
         'native-schedule-budget', 'host-compatibility-current']
if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME'), 'Isolated HOME required'
    subprocess.run(['python3', str(ROOT / 'scripts/build-module-index.py'), '--check'], check=True)
    raise SystemExit(subprocess.run(['node', '--test', '--test-concurrency=1',
        *[str(ROOT / 'tests' / (name + '.test.mjs')) for name in TESTS]], cwd=ROOT).returncode)
