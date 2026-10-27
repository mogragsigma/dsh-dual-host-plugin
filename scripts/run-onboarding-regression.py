"""Reviewed alpha69 suite. No external credentials, models, Git writes or live Host actions.
Tests use synthetic services, temporary files and loopback listeners.
Historical tests outside this list require a separate scope review.
"""
from pathlib import Path
import os, subprocess, tempfile

ROOT = Path(__file__).resolve().parents[1]
TESTS = [
    'managed-browser-navigation', 'managed-workbench', 'cloud-web-ui-state',
    'onboarding-cloud-web', 'onboarding-local-pair', 'workbench-carrier-headers',
    'workbench-maintenance', 'notification-discovery', 'native-schedule-budget',
    'three-party-rules', 'onboarding-install', 'onboarding-maintenance',
    'onboarding-task-runtime',
]
if __name__ == '__main__':
    # Do not read daily DSH locations. Mode-specific filesystem fixtures require
    # umask 022; their parent remains private, including on a 077 login shell.
    with tempfile.TemporaryDirectory(prefix='dsh-alpha69-unit-') as tmp:
        home = Path(tmp)/'home'
        home.mkdir(mode=0o700)
        env = dict(os.environ, HOME=str(home), DSH_HOME=str(home/'.dsh'),
                   DSH_AGENTS_HOME=str(home/'.agents'), TMPDIR=tmp)
        previous = os.umask(0o022)
        try:
            result = subprocess.run([os.environ.get('NODE', 'node'), '--test',
                *[str(ROOT/'tests'/(name+'.test.mjs')) for name in TESTS]], cwd=ROOT, env=env)
        finally:
            os.umask(previous)
        raise SystemExit(result.returncode)
