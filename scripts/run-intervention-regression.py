"""Reviewed v0.33.0 intervention and release suite. No external credentials, models, Git writes or live Host actions.
Tests use synthetic services, temporary files and loopback listeners.
Historical tests outside this list require a separate scope review.
"""
from pathlib import Path
import os, subprocess, tempfile

ROOT = Path(__file__).resolve().parents[1]
TESTS = ['approval-workbench', 'approval-workbench-client', 'approval', 'approval-semantics', 'workbench', 'attention-flow-preview', 'task-focus', 'compact-ui', 'delivery-ui-render', 'repository-ui-render', 'task-board', 'artifacts', 'link-diagnostics', 'ui-contract', 'approval-chat', 'approval-guidance', 'approval-receipts', 'approval-reference', 'approval-semantic-model', 'onboarding-install', 'three-party-rules', 'task-interventions', 'task-interventions-ui', 'workbench-decisions', 'workbench-interaction-runtime', 'approval-local-relay', 'approval-local-gateway', 'notification-defaults', 'notification-discovery', 'notification-feishu', 'notification-version', 'task-notifications', 'intervention-actions', 'intervention-client', 'task-worker', 'worker-budget', 'worker-output-diagnostics', 'artifact-download', 'artifact-download-client', 'artifact-download-ui', 'task-results', 'onboarding-maintenance', 'approval-credential-reference', 'market-bundle', 'release-promotion']
if __name__ == '__main__':
    # Do not read daily DSH locations. Mode-specific filesystem fixtures require
    # umask 022; their parent remains private, including on a 077 login shell.
    with tempfile.TemporaryDirectory(prefix='dsh-v033-unit-') as tmp:
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
