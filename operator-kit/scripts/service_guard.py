"""Operator stopped-state adapters; read-only, never stop/start a service.

Bind a live Host's identity before an operator closes it. No boolean 'stopped'
flag is accepted as evidence. Records are private local evidence, not signatures
or business execution approval. Supports current macOS Desktop and Linux systemd.
"""
from pathlib import Path
import json,re,shlex,socket,subprocess,sys
from contextlib import contextmanager
from upgrade_plan import parse,walk,fields,scalar,read,sha,require,PlanError
from stopped_host import processes

CGROUP_ROOT=Path("/sys/fs/cgroup")


def static_exec_start(value):
    # systemctl renders both configuration and the last invocation's result in
    # ExecStart. Pin the complete command prefix; discard only the recognized
    # runtime suffix. Unknown/multiple-command layouts fail closed.
    require(value.count('{ path=')==1 and '} {' not in value,'HOST_EXECSTART_LAYOUT_UNREVIEWED')
    match=re.fullmatch(
        r'(\{ path=.+ ; argv\[\]=.+ ; ignore_errors=(?:yes|no))'
        r' ; start_time=\[[^\]\r\n]*\] ; stop_time=\[[^\]\r\n]*\]'
        r' ; pid=[0-9]+ ; code=(?:\(null\)|exited|killed|dumped)'
        r' ; status=[0-9]+(?:/[A-Za-z0-9_-]+)? \}',value)
    require(match,'HOST_EXECSTART_LAYOUT_UNREVIEWED')
    return match[1]+' }'


def configuration(home,profile):
    home=Path(home).absolute();require(home.resolve()==home and re.fullmatch(r'[A-Za-z0-9_-]+',profile),'HOME_OR_PROFILE_INVALID')
    file=home/'profiles'/profile/'cordis.patch.yml';raw=read(file);tree=parse(raw)
    entries=[fields(n) for n in walk(tree) if hasattr(n,'value') and type(n).__name__=='MappingNode' and 'name' in fields(n) and getattr(fields(n)['name'],'value','').endswith('/native-entry.js')]
    require(len(entries)==1,'OWN_ENTRY_AMBIGUOUS');c=fields(entries[0]['config'])
    ports=[scalar(c['port'],'int')]
    if 'scheduler' in c:ports.append(scalar(fields(c['scheduler'])['lockPort'],'int'))
    if 'ssh' in c:
        forward=scalar(fields(c['ssh'])['forward']);m=re.fullmatch(r'127\.0\.0\.1:(\d+):127\.0\.0\.1:\d+',forward);require(m,'HOST_FORWARD_UNREVIEWED');ports.append(int(m[1]))
    require(all(1024<=p<=65535 for p in ports) and len(set(ports))==len(ports),'HOST_PORTS_INVALID')
    return {'home':str(home),'profile':profile,'ports':ports,'patch':str(file),'role':scalar(c['role'])}


def systemd_state(unit):
    require(re.fullmatch(r'[A-Za-z0-9_.@-]+\.service',unit),'HOST_UNIT_INVALID')
    keys=['Id','LoadState','ActiveState','SubState','MainPID','ControlPID','ControlGroup','ExecStart','Environment','EnvironmentFiles','User','WorkingDirectory','FragmentPath','DropInPaths','NeedDaemonReload']
    p=subprocess.run(['systemctl','show',unit,*sum((['-p',x] for x in keys),[])],capture_output=True,text=True)
    require(p.returncode==0,'HOST_SERVICE_QUERY_FAILED');d=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
    require(set(keys)<=set(d) and d['Id']==unit and d['LoadState']=='loaded' and d['NeedDaemonReload']=='no','HOST_SERVICE_CONFIG_UNREVIEWED')
    # Pin effective configuration, plus files systemd could load on a later start.
    names=[d['FragmentPath'],*shlex.split(d['DropInPaths'])]
    env=shlex.split(d['EnvironmentFiles']);require(len(env)%2==0,'HOST_ENVIRONMENT_FILES_UNREVIEWED')
    for i in range(0,len(env),2):
        require(env[i+1] in ('(ignore_errors=yes)','(ignore_errors=no)'),'HOST_ENVIRONMENT_FILES_UNREVIEWED');names.append(env[i])
    hashes={}
    for name in names:
        require(name and Path(name).is_absolute(),'HOST_SERVICE_FILE_INVALID')
        # Hash without returning environment or command contents to caller/logs.
        hashes[name]=sha(read(Path(name)))
    static={k:d[k] for k in ['Id','ExecStart','Environment','EnvironmentFiles','User','WorkingDirectory','FragmentPath','DropInPaths']}
    static['ExecStart']=static_exec_start(d['ExecStart'])
    static['fileHashes']=hashes
    return {'config_sha256':sha(json.dumps(static,sort_keys=True).encode()),'active':d['ActiveState'],'sub':d['SubState'],'main_pid':int(d['MainPID']),'control_pid':int(d['ControlPID']),'cgroup':d['ControlGroup']}


def proc_identity(pid):
    path=Path('/proc')/str(pid)
    try:
        argv=(path/'cmdline').read_bytes().split(b'\0');environment=dict(x.split(b'=',1) for x in (path/'environ').read_bytes().split(b'\0') if b'=' in x)
        home=environment.get(b'DSH_HOME') or environment.get(b'HOME',b'')+b'/.dsh'
        words=[x.decode() for x in argv if x]
        profiles=[words[i+1] for i,x in enumerate(words[:-1]) if x=='--profile']
        ports=[words[i+1] for i,x in enumerate(words[:-1]) if x=='--port']
        require(len(profiles)==1 and len(ports)==1 and ports[0].isdigit(),'HOST_SERVICE_COMMAND_UNREVIEWED')
        return {'home':home.decode(),'profile':profiles[0],'web_port':int(ports[0])}
    except (OSError,UnicodeError,ValueError):raise PlanError('HOST_PROCESS_IDENTITY_UNAVAILABLE') from None


def app_identity(application):
    p=Path(application).absolute();require(p.resolve()==p and p.name.endswith('.app') and p.is_dir(),'HOST_APPLICATION_INVALID')
    binary=p/'Contents/MacOS/DeepSeek Harness';s=binary.stat();require(binary.resolve()==binary and binary.is_file(),'HOST_APPLICATION_INVALID')
    return {'application':str(p),'binary_identity':{'dev':s.st_dev,'ino':s.st_ino,'size':s.st_size,'mtime_ns':s.st_mtime_ns}}


def capture(home,profile,kind,application=None,unit=None):
    scope=configuration(home,profile);r={'schema':1,'kind':kind,**scope}
    if kind=='macos-desktop':
        require(scope['role']=='local' and sys.platform=='darwin' and profile=='desktop' and Path(home)==Path.home()/'.dsh','HOST_DESKTOP_SCOPE_UNREVIEWED')
        a=app_identity(application);r.update(a);pids=[pid for pid,cmd in processes() if a['application']+'/' in cmd]
        require(pids,'HOST_LIVE_IDENTITY_REQUIRED');r['pids']=pids
    elif kind=='systemd-service':
        require(scope['role']=='cloud' and sys.platform.startswith('linux'),'HOST_PLATFORM_MISMATCH')
        require((CGROUP_ROOT/'cgroup.controllers').is_file(),'HOST_CGROUP_LAYOUT_UNSUPPORTED');s=systemd_state(unit)
        require(s['active']=='active' and s['main_pid']>1,'HOST_LIVE_IDENTITY_REQUIRED')
        ident=proc_identity(s['main_pid']);require(ident['home']==scope['home'] and ident['profile']==profile,'HOST_SERVICE_SCOPE_MISMATCH')
        require(s['cgroup'].startswith('/') and '..' not in Path(s['cgroup']).parts,'HOST_CGROUP_INVALID')
        r.update({'unit':unit,'config_sha256':s['config_sha256'],'systemd_fingerprint_contract':2,'cgroup':s['cgroup'],'pids':[s['main_pid']]})
        r['ports']=list(dict.fromkeys([*r['ports'],ident['web_port']]))
    else:raise PlanError('HOST_KIND_UNSUPPORTED')
    require(all(1024<=p<=65535 for p in r['ports']),'HOST_PORTS_INVALID')
    return r


class ServiceStoppedLease:
    def __init__(self,record,expected_sha256):
        self.path=Path(record).absolute();self.proof=expected_sha256;self.sockets=[]
        raw=read(self.path);require(sha(raw)==self.proof,'HOST_RECORD_CHANGED');self.r=json.loads(raw)
        r=self.r;require(r.get('schema')==1 and r.get('kind') in ('macos-desktop','systemd-service'),'HOST_RECORD_INVALID')
        require(r.get('pids') and all(type(p)==int and p>1 for p in r['pids']),'HOST_RECORD_IDENTITY')
        require(r.get('ports') and all(type(p)==int and 1024<=p<=65535 for p in r['ports']) and len(set(r['ports']))==len(r['ports']),'HOST_RECORD_PORTS')
        self.home=Path(r['home']);require(self.home.resolve()==self.home and self.home.is_absolute(),'HOST_RECORD_PATH')

    def assert_processes_stopped(self):
        r=self.r;require(sha(read(self.path))==self.proof,'HOST_RECORD_CHANGED')
        scope=configuration(self.home,r['profile']);require(scope['role']==r['role'] and set(scope['ports'])<=set(r['ports']),'HOST_GUARD_SCOPE_MISMATCH')
        if r['kind']=='macos-desktop':
            require(sys.platform=='darwin' and r['profile']=='desktop' and self.home==Path.home()/'.dsh','HOST_DESKTOP_SCOPE_UNREVIEWED')
            a=app_identity(r['application']);require(a['binary_identity']==r['binary_identity'],'HOST_APPLICATION_CHANGED')
            require(not any(pid in r['pids'] or a['application']+'/' in cmd for pid,cmd in processes()),'HOST_STILL_RUNNING')
        else:
            require(sys.platform.startswith('linux'),'HOST_PLATFORM_MISMATCH')
            require(r.get('systemd_fingerprint_contract')==2,'HOST_SERVICE_RECORD_RECAPTURE_REQUIRED')
            require((CGROUP_ROOT/'cgroup.controllers').is_file(),'HOST_CGROUP_LAYOUT_UNSUPPORTED');s=systemd_state(r['unit'])
            require(s['config_sha256']==r['config_sha256'],'HOST_SERVICE_CHANGED')
            require(s['active']=='inactive' and s['sub']=='dead' and s['main_pid']==0 and s['control_pid']==0,'HOST_STILL_RUNNING')
            require(s['cgroup'] in ('',r['cgroup']),'HOST_CGROUP_CHANGED')
            root=CGROUP_ROOT/r['cgroup'].lstrip('/')
            require('..' not in root.parts and root.resolve()==root,'HOST_CGROUP_INVALID')
            if root.exists():
                for p in root.rglob('cgroup.procs'):require(not p.read_text().strip(),'HOST_CGROUP_NOT_EMPTY')
            require(not any(pid in r['pids'] for pid,_ in processes()),'HOST_STILL_RUNNING')

    def assert_stopped(self,home,profile,required_ports=()):
        require(Path(home)==self.home and profile==self.r['profile'],'HOST_GUARD_SCOPE_MISMATCH')
        require(set(p for p in required_ports if p is not None)<=set(self.r['ports']),'HOST_GUARD_PORT_MISSING')
        require(len(self.sockets)==len(self.r['ports']) and all(s.fileno()>=0 for s in self.sockets),'HOST_GUARD_NOT_HELD');self.assert_processes_stopped()

    @contextmanager
    def hold(self):
        require(not self.sockets,'HOST_GUARD_ALREADY_HELD');self.assert_processes_stopped()
        try:
            for port in self.r['ports']:
                s=socket.socket();self.sockets.append(s)
                try:s.bind(('127.0.0.1',port));s.listen(1)
                except OSError:raise PlanError('HOST_PORT_NOT_RELEASED') from None
            self.assert_stopped(self.home,self.r['profile']);yield self;self.assert_stopped(self.home,self.r['profile'])
        finally:
            for s in self.sockets:s.close()
            self.sockets=[]
