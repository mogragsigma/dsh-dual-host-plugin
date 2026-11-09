"""R3 execution contracts; real Host/endpoint scenarios are separate evidence."""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    assert os.environ.get('DSH_HOME') and os.environ.get('DSH_AGENTS_HOME'), 'Isolated HOME required'
    subprocess.run(['python3', str(ROOT / 'scripts/build-module-index.py'), '--check'], check=True)
    tests = ['managed-runtime.test.mjs', 'managed-execution.test.mjs', 'managed-policy.test.mjs', 'managed-endpoint.test.mjs', 'managed-rpc.test.mjs', 'managed-search.test.mjs', 'managed-command.test.mjs']
    raise SystemExit(subprocess.run(['node', '--test', *[str(ROOT / 'tests' / f) for f in tests]], cwd=ROOT).returncode)
