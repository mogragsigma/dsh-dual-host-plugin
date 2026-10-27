"""Run only reviewed zero-Git-write tests. Never expand tests/*.test.mjs."""
from pathlib import Path
import argparse, subprocess
TESTS = [
    'approval-reference.test.mjs',
    'delivery-artifacts.test.mjs', 'delivery-artifact-ui.test.mjs', 'artifacts.test.mjs', 'notification-media.test.mjs',
    'task-branch.test.mjs', 'workspace-assets.test.mjs',
    'repository-ui-render.test.mjs',
    'delivery-process-receipts.test.mjs', 'delivery-receipt-linux.test.mjs', 'delivery-push-recovery.test.mjs',
    'delivery-push-approval.test.mjs', 'delivery-push-runtime.test.mjs',
    'delivery-process.test.mjs', 'delivery-ssh.test.mjs', 'delivery-push-adapter.test.mjs',
    'delivery-push.test.mjs', 'delivery-object-plan.test.mjs', 'delivery-journal.test.mjs', 'delivery-git-read.test.mjs', 'delivery-index.test.mjs', 'delivery-commit.test.mjs',
    'delivery-recovery.test.mjs', 'delivery-lock-recovery.test.mjs',
    'delivery-runtime.test.mjs', 'delivery-gateway.test.mjs', 'delivery-ui-render.test.mjs',
    'delivery-approval.test.mjs', 'approval-chat.test.mjs', 'approval-semantics.test.mjs',
    'approval-receipts.test.mjs', 'approval-guidance.test.mjs',
    'delivery-foundation-boundary.test.mjs', 'development-version.test.mjs',
    'ui-contract.test.mjs', 'native-entry-baseline.test.mjs', 'direct-peer.test.mjs',
]
if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--node', default='node')
    args = p.parse_args()
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([args.node, '--test', *[str(root/'tests'/n) for n in TESTS]], cwd=root)
    raise SystemExit(result.returncode)
