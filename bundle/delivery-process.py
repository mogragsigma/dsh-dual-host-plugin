"""Private Linux child-tree supervisor. No shell, retries, or PID-disappearance proof.

The parent journals the supervisor before use. Only this supervisor's ECHILD after
waitpid reaping, plus closed output pipes, proves its managed descendants drained.
An absent/invalid final report never proves drainage, even if this process exited.
"""
import base64
import ctypes
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time


def supervise(argv, cwd, env, timeout=20.0, limit=1048576, expected_parent=None):
    if sys.platform != 'linux':
        raise RuntimeError('PLATFORM_UNSUPPORTED')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise RuntimeError('SUBREAPER_UNAVAILABLE')
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        raise RuntimeError('SUBREAPER_UNAVAILABLE')
    stopping = [False]
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *_: stopping.__setitem__(0, True))
    parent = os.getppid()
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise RuntimeError('PARENT_SIGNAL_UNAVAILABLE')
    if os.getppid() != parent or expected_parent is not None and parent != expected_parent:
        stopping[0] = True
    if stopping[0]:
        return dict(drained=True, started=False, code=None, signal=None, cause='ABORTED', stdout='', reaped=0)
    child = None
    pipes = selectors.DefaultSelector()
    out, total, reaped, code, main_done = bytearray(), 0, 0, None, False
    cause, kill_since = None, None
    start = time.monotonic()
    try:
        try:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     shell=False, start_new_session=True, close_fds=True)
        except OSError:
            return dict(drained=True, started=False, code=None, signal=None, cause='SPAWN_FAILED', stdout='', reaped=0)
        for stream, label in [(child.stdout, 'out'), (child.stderr, 'err')]:
            os.set_blocking(stream.fileno(), False)
            pipes.register(stream, selectors.EVENT_READ, label)
        while True:
            empty = False
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:  # ECHILD, not kill(pid, 0) or /proc absence.
                    empty = True
                    break
                if pid == 0:
                    break
                reaped += 1
                if pid == child.pid:
                    code = os.waitstatus_to_exitcode(status)
                    child.returncode = code
                    main_done = True
                else:
                    cause = cause or 'ORPHANED_DESCENDANT'
            now = time.monotonic()
            if stopping[0]:
                cause = cause or 'ABORTED'
            if now - start >= timeout:
                cause = cause or 'TIMEOUT'
            if main_done and not empty:
                cause = cause or 'ORPHANED_DESCENDANT'
            if cause and not empty:
                kill_since = kill_since or now
                # Only our unreaped direct/adopted children. Do not kill a cached
                # process-group ID that could be reused after its leader was reaped.
                try:
                    with open(f'/proc/self/task/{os.getpid()}/children', encoding='ascii') as f:
                        children = [int(x) for x in f.read().split()]
                    for pid in children:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                except OSError:
                    cause = 'DRAIN_UNKNOWN'
                    break
                if now - kill_since > 5:
                    cause = 'DRAIN_UNKNOWN'
                    break
            for key, _ in pipes.select(0.02):
                try:
                    data = os.read(key.fileobj.fileno(), 65536)
                except BlockingIOError:
                    continue
                if not data:
                    pipes.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                total += len(data)
                if total > limit:
                    cause = cause or 'OUTPUT_LIMIT'
                elif key.data == 'out':
                    out.extend(data)
            if empty and main_done and not pipes.get_map():
                return dict(drained=True, started=True, code=code if code >= 0 else None,
                            signal=signal.Signals(-code).name if code < 0 else None,
                            cause=cause, stdout=base64.b64encode(out).decode('ascii'), reaped=reaped)
            if now - start > timeout + 6:
                cause = 'DRAIN_UNKNOWN'
                break
        return dict(drained=False, started=True, code=None, signal=None, cause='DRAIN_UNKNOWN', stdout='', reaped=reaped)
    finally:
        for key in list(pipes.get_map().values()):
            key.fileobj.close()
        pipes.close()


def receipt_directory(binding, nonce):
    keys = {'schema', 'operation_id', 'action_id', 'epoch', 'intent_fingerprint',
            'plan_fingerprint', 'nonce', 'boot_id', 'directory', 'binding_hash'}
    if not isinstance(binding, dict) or set(binding) != keys:
        raise ValueError()
    body = {k: v for k, v in binding.items() if k != 'binding_hash'}
    encoded = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    directory = binding['directory']
    if (binding['schema'] != 1 or binding['nonce'] != nonce or
            not re.fullmatch(r'delivery-op-[a-f0-9-]{36}', binding['operation_id']) or
            not re.fullmatch(r'delivery-[a-f0-9-]{36}', binding['action_id']) or
            type(binding['epoch']) is not int or not 1 <= binding['epoch'] <= 9007199254740991 or
            any(not isinstance(binding[k], str) or not re.fullmatch(r'[a-f0-9]{64}', binding[k])
                for k in ['intent_fingerprint', 'plan_fingerprint', 'nonce', 'binding_hash']) or
            hashlib.sha256(encoded).hexdigest() != binding['binding_hash'] or
            not isinstance(directory, dict) or set(directory) != {'path', 'device', 'inode'} or
            not isinstance(directory['path'], str) or not directory['path'].startswith('/') or
            len(directory['path']) > 2048 or os.path.realpath(directory['path']) != directory['path']):
        raise ValueError()
    with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as source:
        if source.read().strip() != binding['boot_id']:
            raise ValueError()
    fd = os.open(directory['path'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        if (not stat.S_ISDIR(current.st_mode) or current.st_mode & 0o077 or
                current.st_uid != os.geteuid() or str(current.st_dev) != directory['device'] or
                str(current.st_ino) != directory['inode']):
            raise ValueError()
        return fd
    except Exception:
        os.close(fd)
        raise


def seal_receipt(fd, binding, result):
    # Called only after supervise returned ECHILD + closed descendant pipes.
    # No child is ever started after this point. Publish once, without replacing
    # any existing report; fsync bytes and directory before stdout acknowledgement.
    if result['drained'] is not True:
        return
    with open('/proc/self/stat', encoding='ascii') as source:
        start_ticks = source.read().rsplit(')', 1)[1].strip().split()[19]
    report = {k: v for k, v in result.items() if k != 'stdout'}
    data = json.dumps({'schema': 1, 'kind': 'sealed-process-receipt-v1',
                       'operation_id': binding['operation_id'], 'binding_hash': binding['binding_hash'],
                       'boot_id': binding['boot_id'], 'pid': os.getpid(), 'start_ticks': start_ticks,
                       'report': {'schema': 1, 'nonce': binding['nonce'], **report}},
                      sort_keys=True, separators=(',', ':')).encode()
    if len(data) > 16384:
        raise ValueError()
    temporary, final = '.'+binding['nonce']+'.tmp', binding['nonce']+'.json'
    output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(output, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, final, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=fd)
        os.fsync(fd)
    except Exception:
        # Retain an incomplete private file for diagnosis, never overwrite/adopt it.
        raise


def main():
    # Private IPC only. The public plugin accepts opaque plans, never argv/env.
    receipt_fd = None
    try:
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError()
        request = json.loads(raw)
        keys = {'argv', 'cwd', 'env', 'timeout', 'limit', 'nonce', 'parent_pid'}
        if set(request) not in (keys, keys | {'receipt'}):
            raise ValueError()
        argv, env = request['argv'], request['env']
        if (not isinstance(argv, list) or not 1 <= len(argv) <= 100 or
                any(not isinstance(x, str) or '\0' in x or len(x) > 8192 for x in argv) or
                not argv[0].startswith('/') or not isinstance(env, dict) or len(env) > 100 or
                any(not isinstance(k, str) or not isinstance(v, str) or '=' in k or '\0' in k+v for k, v in env.items()) or
                not isinstance(request['cwd'], str) or not request['cwd'].startswith('/') or
                not 0.05 <= request['timeout'] <= 60 or not 1 <= request['limit'] <= 1048576 or
                not isinstance(request['parent_pid'], int) or request['parent_pid'] < 1 or
                not isinstance(request['nonce'], str) or not re.fullmatch(r'[a-f0-9]{64}', request['nonce'])):
            raise ValueError()
        if 'receipt' in request:
            receipt_fd = receipt_directory(request['receipt'], request['nonce'])
        result = supervise(argv, request['cwd'], env, request['timeout'], request['limit'], request['parent_pid'])
        if receipt_fd is not None:
            seal_receipt(receipt_fd, request['receipt'], result)
        print(json.dumps({'schema': 1, 'nonce': request['nonce'], **result}), flush=True)
    except Exception:
        # Never expose argv, keys, environment, Git stderr or exception strings.
        print(json.dumps({'schema': 1, 'drained': False, 'cause': 'SUPERVISOR_FAILED'}), flush=True)
        raise SystemExit(1)
    finally:
        if receipt_fd is not None:
            os.close(receipt_fd)


if __name__ == '__main__':
    main()
