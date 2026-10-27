"""Read-only audit of the proposed Git source snapshot; prints paths, never values.

Use --index immediately before commit to audit the exact staged bytes. No Host,
credential store, model service, repository checkout or remote mutation is used.
Pattern checks supplement review; they cannot prove absence of every possible secret.
"""
from pathlib import Path
import argparse, hashlib, json, re, subprocess

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'.gitignore', 'README.md', 'AGENTS.md', 'CHECKPOINT.md', 'SOURCE-MANIFEST.json'}
DIRECTORIES = {'bundle', 'docs', 'operator-kit', 'scripts', 'tests', 'ui-source'}
FORBIDDEN_PARTS = {'private', 'runtime', 'runtime-home', 'node_modules', '__pycache__', '.git'}
FORBIDDEN_NAMES = {'config.json', 'tokens.json', 'credentials.json', '.credentials.yaml', '.DS_Store'}
FORBIDDEN_SUFFIXES = ('.pyc', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.log', '.pem', '.key', '.tgz', '.zip')
# Neutral source distribution: disallowed product-name spellings are data, not runtime rules.
WORDS = tuple(bytes(x) for x in [(99,104,97,116,103,112,116),(99,111,100,101,120)])
PATTERNS = {
    'private_key_material': re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}-----END [A-Z ]*PRIVATE KEY-----'),
    'aws_access_id': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'api_key_shape': re.compile(rb'\bsk-[A-Za-z0-9_-]{32,}\b'),
    'github_token_shape': re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{30,}\b'),
    'jwt_shape': re.compile(rb'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b'),
    'production_chat_id': re.compile(rb'\b(?:oc_|om_)[a-f0-9]{32}\b'),
    'url_credential': re.compile(rb'https?://[^\s/"\']+:[^\s/"\']+@'),
}

def run(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def inspect(index=False):
    if index:
        raw = run('ls-files', '--stage', '-z').split(b'\0'); entries=[]
        for item in raw:
            if not item: continue
            meta,name=item.split(b'\t',1);mode,oid,stage=meta.split()
            assert stage==b'0', 'Unmerged index'
            entries.append((name.decode(),mode.decode(),oid.decode()))
    else:
        names=run('ls-files','--cached','--others','--exclude-standard','-z').decode().split('\0')
        entries=[(n,None,None) for n in sorted(set(names)) if n]
    fixturePath=ROOT/'docs/source-audit-fixtures.json'
    fixtureBytes=run('show',':docs/source-audit-fixtures.json') if index else fixturePath.read_bytes()
    fixtures=json.loads(fixtureBytes)['files']
    hashes={};issues=[]; reviewed=[]
    for name,mode,oid in entries:
        p=Path(name);parts=p.parts
        if not parts or p.is_absolute() or '..' in parts or (len(parts)==1 and name not in ROOT_FILES) or (len(parts)>1 and parts[0] not in DIRECTORIES):
            issues.append([name,'unexpected_source_path']);continue
        if set(parts)&FORBIDDEN_PARTS or p.name in FORBIDDEN_NAMES or p.name.startswith('.env') or name.endswith(FORBIDDEN_SUFFIXES):
            issues.append([name,'forbidden_artifact']);continue
        path=ROOT/name
        if (index and mode not in ('100644','100755')) or (not index and (path.is_symlink() or not path.is_file())):
            issues.append([name,'not_regular_source_file']);continue
        data=run('cat-file','blob',oid) if index else path.read_bytes()
        if len(data)>12*1024*1024:issues.append([name,'oversize_review'])
        if any(w in name.lower().encode() or w in data.lower() for w in WORDS):issues.append([name,'disallowed_product_reference'])
        for label,pattern in PATTERNS.items():
            if pattern.search(data):
                review=fixtures.get(name,{})
                if review.get('sha256')==hashlib.sha256(data).hexdigest() and label in review.get('patterns',[]):
                    reviewed.append([name,label])
                else:issues.append([name,label])
        hashes[name]=hashlib.sha256(data).hexdigest()
    return {'index':index,'files':len(hashes),'issues':issues,'reviewedSyntheticPatterns':len(reviewed),'hashes':hashes}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--index',action='store_true');args=p.parse_args()
    result=inspect(args.index);result.pop('hashes')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(bool(result['issues']))
