"""Fixed, pre-Node Linux bootstrap. Invoked only by our authenticated SSH adapter.

No package manager, shell startup file, sudo, model, service or global Node mutation.
The standard-library Python runtime is a detected prerequisite, never silently installed.
"""
import base64
import contextlib
import fcntl
import hashlib
import hmac
import io
import json
import os
import platform
import posixpath
import pwd
import re
import signal
import ssl
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

OWNER = 'dsh-dual-host-node-bootstrap'
VERSION = '22.23.4'
RELEASES = {
    'x64': 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
    'arm64': 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
}
MAX_ARCHIVE = 134217728
MAX_EXPANDED = 536870912
MAX_ITEMS = 20000
CONTROL = {'.owner.json', '.journal.json', '.inventory.jsonl', '.worker.py', '.worker.log'}
STOP = False


class Refusal(Exception):
    pass


def fail(code):
    raise Refusal('ONBOARDING_NODE_' + code)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(data):
    return hashlib.sha256(data if isinstance(data, bytes) else encoded(data)).hexdigest()


def signed(value, proof):
    return dict(value, signature=hmac.new(bytes.fromhex(proof), encoded(value), hashlib.sha256).hexdigest())


def verified(value, proof):
    if not isinstance(value, dict):
        fail('RECORD_REVIEW')
    body = dict(value)
    signature = body.pop('signature', '')
    if not isinstance(signature, str) or not hmac.compare_digest(signed(body, proof)['signature'], signature):
        fail('RECORD_REVIEW')
    return body


def is_uuid(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value) is not None


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def identity(s):
    return dict(dev=s.st_dev, ino=s.st_ino, uid=s.st_uid, mode=stat.S_IMODE(s.st_mode))


def checked_ancestors(name, missing=False):
    if not isinstance(name, str) or not name.startswith('/') or posixpath.normpath(name) != name or len(name) > 700 or re.search(r'[\x00-\x1f\x7f]', name):
        fail('PATH_REVIEW')
    result = []
    for part in [''] + name.split('/')[1:]:
        current = '/' if not result else posixpath.join(result[-1]['path'], part)
        try:
            s = os.lstat(current)
        except FileNotFoundError:
            if not missing:
                fail('PATH_MISSING')
            result.append(dict(path=current, missing=True))
            continue
        if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):
            fail('PATH_REVIEW')
        if result and result[-1].get('missing'):
            fail('PATH_REVIEW')
        result.append(dict(path=current, **identity(s)))
    return result


def regular(name, limit=2097152):
    checked_ancestors(posixpath.dirname(name))
    s = os.lstat(name)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid() or s.st_size > limit:
        fail('FILE_REVIEW')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if identity(before) != identity(s):
            fail('FILE_REVIEW')
        data = bytearray()
        while True:
            chunk = os.read(fd, min(1048576, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > limit:
                fail('FILE_REVIEW')
        after = os.fstat(fd)
        if identity(after) != identity(before) or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns or len(data) != before.st_size:
            fail('FILE_REVIEW')
        return bytes(data), identity(s)
    finally:
        os.close(fd)


def new_file(name, data, mode=0o600):
    checked_ancestors(posixpath.dirname(name))
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(data)
            f.flush()
            os.fsync(fd)
        return identity(os.fstat(fd))
    finally:
        os.close(fd)


def atomic(name, data):
    # The caller holds the owner-file lock. Never replace a symlink/foreign file.
    old, ident = regular(name)
    if ident['mode'] != 0o600:
        fail('RECORD_REVIEW')
    temp = name + '.next-' + str(uuid.uuid4())
    new_file(temp, data)
    try:
        if regular(name)[1] != ident:
            fail('RECORD_REVIEW')
        os.replace(temp, name)
        fd = os.open(posixpath.dirname(name), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass


def process_identity(pid=None):
    pid = os.getpid() if pid is None else pid
    if not isinstance(pid, int) or pid <= 1:
        fail('PROCESS_REVIEW')
    try:
        with open('/proc/%s/stat' % pid) as f:
            parts = f.read(4096).rsplit(')', 1)[1].split()
        with open('/proc/sys/kernel/random/boot_id') as f:
            boot = f.read(128).strip()
        return dict(pid=pid, boot=boot, start=parts[19], group=int(parts[2]), state=parts[0])
    except FileNotFoundError:
        return None


def birth(p):
    return {k: p[k] for k in ['pid', 'boot', 'start', 'group']} if p else None


def active(p):
    if not p:
        return False
    actual = process_identity(p['pid'])
    return actual is not None and birth(actual) == birth(p) and actual['state'] not in ['Z', 'X']


def release(arch):
    if arch not in RELEASES:
        fail('ARCH_UNSUPPORTED')
    directory = 'node-v%s-linux-%s' % (VERSION, arch)
    return dict(version=VERSION, arch=arch, directory=directory, url='https://nodejs.org/dist/v%s/%s.tar.gz' % (VERSION, directory), sha256=RELEASES[arch], maxArchiveBytes=MAX_ARCHIVE, maxExpandedBytes=MAX_EXPANDED)


def target(q):
    if not is_uuid(q.get('installationId')):
        fail('ARGUMENTS')
    home = pwd.getpwuid(os.getuid()).pw_dir
    parent = q.get('parent') or posixpath.join(home, '.local/share/dsh-dual-host/instances')
    if not isinstance(parent, str) or parent in ['/', home] or home.startswith(parent + '/'):
        fail('PATH_REVIEW')
    checked_ancestors(parent, missing=True)
    return parent, posixpath.join(parent, 'node-' + q['installationId'])


def inspect(q):
    parent, root = target(q)
    if sys.version_info < (3, 8) or sys.platform != 'linux':
        fail('PYTHON_PLATFORM_UNSUPPORTED')
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    rel = release(arch)
    kernel = platform.release()
    kernel_version = re.match(r'^(\d+)\.(\d+)(?:\.|-)', kernel)
    if not kernel_version or (int(kernel_version[1]), int(kernel_version[2])) < (4, 18):
        fail('KERNEL_UNSUPPORTED')
    try:
        libc = os.confstr('CS_GNU_LIBC_VERSION')
    except (ValueError, OSError):
        libc = None
    match = re.fullmatch(r'glibc (\d+)\.(\d+)', libc or '')
    if not match or (int(match[1]), int(match[2])) < (2, 28):
        fail('LIBC_UNSUPPORTED')
    rows = checked_ancestors(root, missing=True)
    anchor = next(r for r in reversed(rows) if not r.get('missing'))
    disk = os.statvfs(anchor['path'])
    executable = os.path.realpath(sys.executable)
    exe = os.stat(executable)
    plan = dict(schema=1, installationId=q['installationId'], root=root, parent=parent, home=pwd.getpwuid(os.getuid()).pw_dir, sourceRoot=posixpath.join(parent, 'host-' + q['installationId']), platform='linux', arch=arch, kernel=kernel, libc=libc, python=dict(path=executable, version=platform.python_version(), **identity(exe)), ancestors=rows, rootExists=not rows[-1].get('missing', False), release=rel, systemNodeModified=False, npmGlobalModified=False, serviceStarted=False, modelEnabled=False)
    return dict(plan, fingerprint=digest(plan), freeBytes=disk.f_bavail * disk.f_frsize, writable=os.access(anchor['path'], os.W_OK | os.X_OK), remoteWrites=0)


def request(q):
    common = ['action', 'installationId', 'parent']
    action = q.get('action') if isinstance(q, dict) else None
    fields = common if action == 'preview' else common + ['operationId', 'proof']
    if action == 'start':
        fields += ['fingerprint']
    if action not in ['preview', 'start', 'status', 'stop', 'rollback', 'worker'] or not exact(q, fields):
        fail('ARGUMENTS')
    target(q)
    if action != 'preview' and (not is_uuid(q['operationId']) or not isinstance(q['proof'], str) or not re.fullmatch('[a-f0-9]{64}', q['proof'])):
        fail('ARGUMENTS')
    if action == 'start' and not re.fullmatch('[a-f0-9]{64}', str(q['fingerprint'])):
        fail('ARGUMENTS')


def load(q):
    _, root = target(q)
    try:
        s = os.lstat(root)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o700 or s.st_uid != os.getuid():
        fail('OWNER_REVIEW')
    raw, owner_identity = regular(root + '/.owner.json')
    owner = verified(json.loads(raw), q['proof'])
    if owner.get('owner') != OWNER or owner.get('schema') != 1 or owner.get('operationId') != q['operationId'] or owner.get('installationId') != q['installationId'] or owner.get('root') != root or owner.get('rootIdentity') != identity(s) or owner_identity['mode'] != 0o600:
        fail('OWNER_REVIEW')
    data, journal_identity = regular(root + '/.journal.json')
    j = verified(json.loads(data), q['proof'])
    if j.get('operationId') != owner['operationId'] or j.get('ownerHash') != digest(owner) or journal_identity['mode'] != 0o600 or not isinstance(j.get('revision'), int) or j['revision'] < 1:
        fail('JOURNAL_REVIEW')
    return owner, j


def save(q, owner, j):
    if identity(os.lstat(owner['root'])) != owner['rootIdentity']:
        fail('OWNER_REVIEW')
    j['revision'] += 1
    j['updatedAt'] = int(time.time() * 1000)
    atomic(owner['root'] + '/.journal.json', encoded(signed(j, q['proof'])))


@contextlib.contextmanager
def lock(owner):
    fd = os.open(owner['root'] + '/.owner.json', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('BUSY')
        yield
    finally:
        os.close(fd)


def inventory(q, owner, j):
    data, ident = regular(owner['root'] + '/.inventory.jsonl', 33554432)
    if ident['mode'] != 0o600:
        fail('INVENTORY_REVIEW')
    head = '0' * 64
    found = j['head'] == head
    items = {}
    count = 0
    for line in data.splitlines():
        count += 1
        if count > MAX_ITEMS * 3:
            fail('INVENTORY_LIMIT')
        entry = verified(json.loads(line), q['proof'])
        if entry.get('previous') != head or entry.get('operationId') != q['operationId'] or not isinstance(entry.get('item'), dict):
            fail('INVENTORY_REVIEW')
        item = entry['item']
        name = item.get('path')
        if not isinstance(name, str) or name.startswith('/') or posixpath.normpath(name) != name or name in CONTROL or name in ['.', '..'] or name.startswith('../') or '\\' in name or re.search('[\x00-\x1f\x7f]', name):
            fail('INVENTORY_REVIEW')
        if name in items and items[name]['identity'] != item.get('identity'):
            fail('INVENTORY_REVIEW')
        items[name] = item
        head = digest(line)
        found = found or head == j['head']
    if not found:
        fail('INVENTORY_REVIEW')
    return items, head


def append(q, owner, j, item):
    line = encoded(signed(dict(operationId=q['operationId'], previous=j['head'], item=item), q['proof']))
    name = owner['root'] + '/.inventory.jsonl'
    checked_ancestors(owner['root'])
    initial = os.lstat(name)
    if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1 or initial.st_uid != os.getuid() or stat.S_IMODE(initial.st_mode) != 0o600 or initial.st_size > 33554432:
        fail('INVENTORY_REVIEW')
    before = identity(initial)
    fd = os.open(name, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
    try:
        if identity(os.fstat(fd)) != before:
            fail('INVENTORY_REVIEW')
        pending = memoryview(line + b'\n')
        while pending:
            pending = pending[os.write(fd, pending):]
        os.fsync(fd)
    finally:
        os.close(fd)
    j['head'] = digest(line)
    save(q, owner, j)


def owned_directory(q, owner, j, name):
    p = owner['root'] + '/' + name
    checked_ancestors(posixpath.dirname(p))
    os.mkdir(p, 0o700)
    append(q, owner, j, dict(path=name, kind='directory', identity=identity(os.lstat(p))))


def write_stream(q, owner, j, name, reader, limit, executable=False):
    p = owner['root'] + '/' + name
    checked_ancestors(posixpath.dirname(p))
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if executable else 0o600)
    ident = identity(os.fstat(fd))
    h, size = hashlib.sha256(), 0
    try:
        append(q, owner, j, dict(path=name, kind='file', identity=ident, bytes=0, sha256=h.hexdigest()))
        while True:
            if STOP:
                fail('STOPPED')
            chunk = reader.read(1048576)
            if not chunk:
                break
            if size + len(chunk) > limit:
                fail('SIZE_LIMIT')
            view = memoryview(chunk)
            while view:
                n = os.write(fd, view)
                h.update(view[:n])
                size += n
                view = view[n:]
        return dict(bytes=size, sha256=h.hexdigest())
    finally:
        os.fsync(fd)
        os.close(fd)
        append(q, owner, j, dict(path=name, kind='file', identity=ident, bytes=size, sha256=h.hexdigest()))


class FixedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Release mirrors, insecure redirects, query strings and custom URLs are not accepted.
        if newurl != req.full_url:
            fail('DOWNLOAD_REDIRECT')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(q, owner, j):
    rel = owner['plan']['release']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), FixedRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(urllib.request.Request(rel['url'], headers={'User-Agent': 'DSH-Dual-Host-Bootstrap/1'}), timeout=30) as response:
        if response.status != 200 or response.geturl() != rel['url']:
            fail('DOWNLOAD_RESPONSE')
        length = response.headers.get('Content-Length')
        if length is not None and (not length.isdecimal() or int(length) > MAX_ARCHIVE):
            fail('SIZE_LIMIT')
        result = write_stream(q, owner, j, 'release.tar.gz', response, MAX_ARCHIVE)
    if result['sha256'] != rel['sha256']:
        fail('ARCHIVE_HASH')


def members(archive, rel):
    prefix = rel['directory']
    entries, names, size = [], set(), 0
    for m in archive:
        name = m.name.rstrip('/') if m.isdir() else m.name
        if len(entries) >= MAX_ITEMS or len(name) > 512 or posixpath.normpath(name) != name or name.startswith('/') or '\\' in name or re.search('[\x00-\x1f\x7f]', name) or not (name == prefix or name.startswith(prefix + '/')) or name in names:
            fail('ARCHIVE_PATH')
        if not (m.isdir() or m.isfile() or m.issym()) or m.mode & 0o7000 or m.size < 0:
            fail('ARCHIVE_TYPE')
        if m.issym():
            dest = posixpath.normpath(posixpath.join(posixpath.dirname(name), m.linkname))
            if posixpath.isabs(m.linkname) or '\\' in m.linkname or re.search('[\x00-\x1f\x7f]', m.linkname) or not dest.startswith(prefix + '/'):
                fail('ARCHIVE_LINK')
        if m.isfile():
            size += m.size
            if m.size > MAX_ARCHIVE or size > MAX_EXPANDED:
                fail('SIZE_LIMIT')
        names.add(name)
        entries.append((name, m))
    if not entries or prefix not in names:
        fail('ARCHIVE_PATH')
    kinds = {name: m for name, m in entries}
    for name, m in entries:
        if name != prefix and (posixpath.dirname(name) not in kinds or not kinds[posixpath.dirname(name)].isdir()):
            fail('ARCHIVE_PATH')
        if m.issym():
            dest = posixpath.normpath(posixpath.join(posixpath.dirname(name), m.linkname))
            if dest not in kinds or not kinds[dest].isfile():
                fail('ARCHIVE_LINK')
    return entries


def unpack(q, owner, j):
    rel = owner['plan']['release']
    data, _ = regular(owner['root'] + '/release.tar.gz', MAX_ARCHIVE)
    if digest(data) != rel['sha256']:
        fail('ARCHIVE_HASH')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        entries = members(archive, rel)  # Validate the entire archive BEFORE extracting a single member.
        for name, m in sorted(entries, key=lambda e: (e[0].count('/'), e[0])):
            if STOP:
                fail('STOPPED')
            if m.isdir():
                owned_directory(q, owner, j, name)
        for name, m in entries:
            if m.isfile():
                with archive.extractfile(m) as src:
                    result = write_stream(q, owner, j, name, src, m.size, executable=bool(m.mode & 0o111))
                if result['bytes'] != m.size:
                    fail('ARCHIVE_HASH')
        for name, m in entries:
            if m.issym():
                p = owner['root'] + '/' + name
                checked_ancestors(posixpath.dirname(p))
                os.symlink(m.linkname, p)
                append(q, owner, j, dict(path=name, kind='link', target=m.linkname, identity=identity(os.lstat(p))))


def verify_inventory(q, owner, j, allow_missing=False):
    items, _ = inventory(q, owner, j)
    expected = set(items) | CONTROL
    found = set()
    for current, directories, files in os.walk(owner['root'], followlinks=False):
        for name in directories + files:
            relative = posixpath.relpath(posixpath.join(current, name), owner['root'])
            if relative not in expected:
                fail('UNKNOWN_CONTENT')
            found.add(relative)
    if not CONTROL <= found:
        fail('CONTROL_REVIEW')
    if not allow_missing and found != expected:
        fail('INVENTORY_DRIFT')
    for name, item in items.items():
        p = owner['root'] + '/' + name
        if name not in found:
            continue
        s = os.lstat(p)
        if identity(s) != item['identity']:
            fail('INVENTORY_DRIFT')
        if item['kind'] == 'directory':
            if not stat.S_ISDIR(s.st_mode):
                fail('INVENTORY_DRIFT')
        elif item['kind'] == 'link':
            if not stat.S_ISLNK(s.st_mode) or os.readlink(p) != item['target']:
                fail('INVENTORY_DRIFT')
        elif item['kind'] == 'file':
            data, _ = regular(p, MAX_ARCHIVE)
            if len(data) != item['bytes'] or digest(data) != item['sha256']:
                fail('INVENTORY_DRIFT')
        else:
            fail('INVENTORY_REVIEW')
    for name in CONTROL:
        data, ident = regular(owner['root'] + '/' + name, 33554432 if name == '.inventory.jsonl' else 2097152)
        if ident['mode'] != 0o600 or name == '.worker.py' and digest(data) != owner['sourceHash'] or name == '.worker.log' and data:
            fail('CONTROL_REVIEW')
    return items


def view(q, value, validate=False):
    if value is None:
        return dict(state='absent', operationId=q['operationId'], automaticRetry=False, systemNodeModified=False)
    owner, j = value
    running = active(j.get('worker')) or active(owner.get('creator'))
    state = j['state']
    if state in ['launching', 'downloading', 'extracting', 'checking'] and not running:
        state = 'needs_review'
    if validate and not running and state == 'ready':
        verify_inventory(q, owner, j)
    return dict(state=state, operationId=q['operationId'], installationId=q['installationId'], root=owner['root'], version=owner['plan']['release']['version'], arch=owner['plan']['arch'], node=owner['root'] + '/' + owner['plan']['release']['directory'] + '/bin/node' if state == 'ready' else None, npm=owner['root'] + '/' + owner['plan']['release']['directory'] + '/bin/npm' if state == 'ready' else None, workerActive=running, worker=birth(j.get('worker')), error=j.get('error'), revision=j['revision'], systemNodeModified=False, serviceStarted=False, automaticRetry=False)


def source_bytes():
    if 'SOURCE' in globals():
        return globals()['SOURCE']
    return regular(os.path.abspath(__file__), 131072)[0]


def start(q):
    prior = load(q)
    if prior:
        if prior[0]['plan']['fingerprint'] != q['fingerprint']:
            fail('PLAN_DRIFT')
        return view(q, prior)
    plan = inspect(q)
    if plan['fingerprint'] != q['fingerprint'] or plan['rootExists'] or not plan['writable'] or plan['freeBytes'] < 2147483648:
        fail('PLAN_DRIFT')
    source = source_bytes()
    # Directory creation is exclusive and bounded by the exact observed ancestor chain.
    created = []
    for entry in plan['ancestors']:
        if entry.get('missing'):
            os.mkdir(entry['path'], 0o700)
            created.append(dict(path=entry['path'], **identity(os.lstat(entry['path']))))
        elif identity(os.lstat(entry['path'])) != {k: entry[k] for k in ['dev', 'ino', 'uid', 'mode']}:
            fail('PLAN_DRIFT')
    root = plan['root']
    owner = dict(owner=OWNER, schema=1, operationId=q['operationId'], installationId=q['installationId'], root=root, rootIdentity=identity(os.lstat(root)), plan=plan, sourceHash=digest(source), creator=birth(process_identity()), createdParents=created[:-1])
    new_file(root + '/.owner.json', encoded(signed(owner, q['proof'])))
    j = dict(schema=1, operationId=q['operationId'], ownerHash=digest(owner), revision=1, state='launching', worker=None, error=None, head='0' * 64, updatedAt=int(time.time() * 1000))
    new_file(root + '/.journal.json', encoded(signed(j, q['proof'])))
    new_file(root + '/.inventory.jsonl', b'')
    new_file(root + '/.worker.py', source)
    new_file(root + '/.worker.log', b'')
    with lock(owner):
        with open(root + '/.worker.log', 'ab') as log:
            child = subprocess.Popen([plan['python']['path'], root + '/.worker.py'], stdin=subprocess.PIPE, stdout=log, stderr=log, cwd=root, start_new_session=True, env={'HOME': root, 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
            j['worker'] = birth(process_identity(child.pid))
            if j['worker'] is None or j['worker']['group'] != child.pid:
                fail('PROCESS_REVIEW')
            save(q, owner, j)
            child.stdin.write(encoded(dict(action='worker', installationId=q['installationId'], parent=q['parent'], operationId=q['operationId'], proof=q['proof'])))
            child.stdin.close()
    return view(q, (owner, j))


def worker(q):
    global STOP
    def stop(_signal, _frame):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(900)
    owner, j = load(q)
    if j['state'] != 'launching' or birth(process_identity()) != j['worker'] or digest(source_bytes()) != owner['sourceHash']:
        fail('WORKER_NOT_AUTHORIZED')
    # Parent releases its lock immediately after sending the request. Bounded wait, no new process.
    for attempt in range(100):
        try:
            with lock(owner):
                try:
                    for state, action in [('downloading', download), ('extracting', unpack)]:
                        if STOP:
                            fail('STOPPED')
                        j['state'] = state
                        save(q, owner, j)
                        action(q, owner, j)
                    j['state'] = 'checking'
                    save(q, owner, j)
                    verify_inventory(q, owner, j)
                    binary = owner['root'] + '/' + owner['plan']['release']['directory'] + '/bin/node'
                    result = subprocess.run([binary, '--version'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, env={'HOME': owner['root'], 'PATH': '/usr/bin:/bin', 'LANG': 'C'})
                    if result.returncode != 0 or result.stdout.strip() != ('v' + VERSION).encode():
                        fail('VERSION_MISMATCH')
                    if STOP:
                        fail('STOPPED')
                    j['state'], j['error'] = 'ready', None
                except Exception as e:
                    j['state'] = 'stopped' if STOP else 'failed'
                    j['error'] = str(e) if isinstance(e, Refusal) else 'ONBOARDING_NODE_BOOTSTRAP_FAILED'
                finally:
                    save(q, owner, j)
                return
        except Refusal as e:
            if str(e) != 'ONBOARDING_NODE_BUSY':
                raise
            time.sleep(0.05)
    fail('BUSY')


def rollback(q, owner, j):
    if active(j.get('worker')) or active(owner.get('creator')):
        fail('PROCESS_ACTIVE')
    # A staged Host still refers to this Node; remove its own runtime/source first.
    if os.path.lexists(owner['plan']['sourceRoot']):
        fail('HOST_REMOVAL_REQUIRED')
    with lock(owner):
        items = verify_inventory(q, owner, j, allow_missing=j['state'] == 'rolling_back')
        j['state'] = 'rolling_back'
        save(q, owner, j)
        for name, item in sorted(items.items(), key=lambda row: (row[0].count('/'), row[0]), reverse=True):
            p = owner['root'] + '/' + name
            try:
                s = os.lstat(p)
            except FileNotFoundError:
                continue
            if identity(s) != item['identity']:
                fail('INVENTORY_DRIFT')
            if item['kind'] == 'directory':
                os.rmdir(p)
            else:
                if item['kind'] == 'file' and digest(regular(p, MAX_ARCHIVE)[0]) != item['sha256'] or item['kind'] == 'link' and os.readlink(p) != item['target']:
                    fail('INVENTORY_DRIFT')
                os.unlink(p)
        # Keep all control records until payload deletion is complete.
        if set(os.listdir(owner['root'])) != CONTROL:
            fail('UNKNOWN_CONTENT')
        verify_inventory(q, owner, j, allow_missing=True)
        controls = {name: regular(owner['root'] + '/' + name, 33554432) for name in CONTROL}
        for name in ['.worker.log', '.worker.py', '.inventory.jsonl', '.journal.json', '.owner.json']:
            if regular(owner['root'] + '/' + name, 33554432) != controls[name]:
                fail('CONTROL_REVIEW')
            os.unlink(owner['root'] + '/' + name)
        os.rmdir(owner['root'])
    # Shared parents are retained, not recursively removed, even when created here.
    return dict(state='rolled_back', operationId=q['operationId'], root=owner['root'], retainedParents=[x['path'] for x in owner['createdParents']], systemNodeModified=False, automaticRetry=False)


def control(q):
    request(q)
    if q['action'] == 'preview':
        return inspect(q)
    if q['action'] == 'start':
        return start(q)
    if q['action'] == 'worker':
        worker(q)
        return None
    value = load(q)
    if q['action'] == 'status':
        return view(q, value, validate=True)
    if value is None:
        fail('STATE_UNKNOWN')
    owner, j = value
    if q['action'] == 'rollback':
        return rollback(q, owner, j)
    # Stop only the recorded Linux birth identity, never pkill, name matching or system Node.
    running = active(j.get('worker'))
    if running:
        os.kill(j['worker']['pid'], signal.SIGTERM)
    return dict(view(q, value), stopRequested=running)


def main():
    os.umask(0o077)
    q = None
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            fail('INPUT_LIMIT')
        q = json.loads(raw)
        result = control(q)
        if q.get('action') != 'worker':
            print(json.dumps(dict(ok=True, value=result)))
    except Exception as e:
        if not isinstance(q, dict) or q.get('action') != 'worker':
            print(json.dumps(dict(ok=False, error=str(e) if isinstance(e, Refusal) else 'ONBOARDING_NODE_OPERATION_FAILED')))


if __name__ == '__main__':
    main()
