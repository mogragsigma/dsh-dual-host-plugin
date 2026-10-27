"""Offline own-candidate archive. No npm, Git, service operations, installation or credentials."""
from pathlib import Path, PurePosixPath
import argparse, gzip, hashlib, io, json, os, tarfile, tempfile
from upgrade_plan import bundle_manifest, read, require, PlanError, sha

MAX_TOTAL=64*1024*1024
MAX_FILES=1024
MAX_FILE=8*1024*1024

def build(candidate, output):
    candidate,output=Path(candidate).absolute(),Path(output).absolute()
    require(not output.is_relative_to(candidate),'OUTPUT_INSIDE_CANDIDATE')
    require(not output.exists() and not output.is_symlink(),'OUTPUT_EXISTS')
    require(output.parent.resolve()==output.parent and output.parent.is_dir(),'OUTPUT_PARENT_UNSAFE')
    manifest,pkg,compat=bundle_manifest(candidate)
    items={f'bundle/{name}':read(candidate/name) for name in manifest}
    # Recheck after reading: packaging cannot silently accept a source edited mid-build.
    require(all(sha(items['bundle/'+name])==value for name,value in manifest.items()),'SOURCE_CHANGED')
    script=Path(__file__).resolve()
    for name in ['upgrade_plan.py','profile_root_policy.py','state_inspection.py','transaction_state.py','install_transaction.py','rollback_patch_review.py','stopped_host.py','service_guard.py','rollback_policy.py','current_rollback_policy.py','alpha17_rollback_policy.py','alpha18_rollback_policy.py','release_bundle.py','operator_cli.py','owner_migration.py']:
        items['tools/'+name]=read(script.with_name(name))
    items['README.md']=read(script.parents[1]/('README.md' if script.parent.name=='tools' else 'README-operator.md'))
    envelope={'schema':2,'kind':'dsh-operator-upgrade-kit','package':pkg['name'],'version':pkg['version'],
              'operatorMutationAvailable':True,'serviceControlIncluded':False,'automaticInstall':False,'automaticPublish':False,
              'globalSkills':compat['globalSkills'],'dependencies':pkg.get('dependencies',{}),
              'files':{n:sha(v) for n,v in sorted(items.items())}}
    items['manifest.json']=(json.dumps(envelope,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
    require(len(items)<=MAX_FILES and sum(map(len,items.values()))<=MAX_TOTAL,'PACKAGE_TOO_LARGE')
    fd,tmp=tempfile.mkstemp(prefix='.dsh-package-',dir=output.parent)
    try:
        with os.fdopen(fd,'wb') as dst:
            with gzip.GzipFile(filename='',fileobj=dst,mode='wb',mtime=0) as gz:
                with tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as archive:
                    for name,data in sorted(items.items()):
                        entry=tarfile.TarInfo(name);entry.size=len(data);entry.mode=0o600;entry.mtime=0
                        archive.addfile(entry,io.BytesIO(data))
            dst.flush();os.fsync(dst.fileno())
        os.link(tmp,output)  # atomic no-clobber; never replace an existing checkpoint
    finally:
        Path(tmp).unlink(missing_ok=True)
    digest=sha(output.read_bytes())
    checked=verify(output,digest)
    return {'file':str(output),'sha256':digest,'bytes':output.stat().st_size,**checked}

def verified_files(archive,expected_sha256):
    require(isinstance(expected_sha256,str) and len(expected_sha256)==64 and all(c in '0123456789abcdef' for c in expected_sha256),'EXPECTED_SHA256_REQUIRED')
    path=Path(archive)
    require(not path.is_symlink() and path.resolve()==path.absolute() and path.stat().st_size<=MAX_TOTAL,'ARCHIVE_UNSAFE')
    data=path.read_bytes();require(sha(data)==expected_sha256,'ARCHIVE_HASH_MISMATCH')
    files={};total=0
    try:
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
            for m in t:
                name=PurePosixPath(m.name)
                require(m.name not in ('','.') and m.isfile() and str(name)==m.name and not name.is_absolute() and '..' not in name.parts and '\\' not in m.name,'ARCHIVE_ENTRY_UNSAFE')
                require(m.name not in files and len(files)<MAX_FILES,'ARCHIVE_DUPLICATE_OR_COUNT')
                require(0<=m.size<=MAX_FILE,'ARCHIVE_ENTRY_SIZE');total+=m.size;require(total<=MAX_TOTAL,'ARCHIVE_EXPANDED_SIZE')
                require(not any(x in {'node_modules','private','.git','.env','__pycache__'} for x in name.parts),'ARCHIVE_PRIVATE_ENTRY')
                files[m.name]=t.extractfile(m).read()
    except (tarfile.TarError,EOFError,OSError):
        raise PlanError('ARCHIVE_INVALID') from None
    require('manifest.json' in files,'MANIFEST_MISSING')
    try:manifest=json.loads(files.pop('manifest.json'))
    except (ValueError,UnicodeError):raise PlanError('MANIFEST_INVALID') from None
    require((manifest.get('schema'),manifest.get('kind')) in [(1,'dsh-candidate-installation-input'),(2,'dsh-operator-upgrade-kit')],'MANIFEST_INVALID')
    require(manifest.get('files')=={n:sha(v) for n,v in files.items()},'MANIFEST_CONTENT_MISMATCH')
    pkg=json.loads(files.get('bundle/package.json',b'{}'))
    require(manifest.get('package')==pkg.get('name')=='@local/dsh-task-gateway' and manifest.get('version')==pkg.get('version'),'MANIFEST_PACKAGE_MISMATCH')
    if manifest['schema']==2:require(manifest.get('operatorMutationAvailable') is True and manifest.get('serviceControlIncluded') is False,'MANIFEST_AUTHORITY_INVALID')
    require(manifest.get('automaticInstall') is False and manifest.get('automaticPublish') is False,'MANIFEST_AUTHORITY_INVALID')
    return files,manifest

def verify(archive,expected_sha256):
    files,manifest=verified_files(archive,expected_sha256)
    return {'version':manifest['version'],'fileCount':len(files)+1,'expectedSha256Matched':True,'contentVerified':True,'signatureVerified':False,'installed':False,'published':False}

def unpack(archive,expected_sha256,destination):
    """Extract verified in-memory regular bytes into a NEW private directory only."""
    files,manifest=verified_files(archive,expected_sha256)
    files['manifest.json']=(json.dumps(manifest,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
    target=Path(destination).absolute()
    require(target.parent.resolve()==target.parent and target.parent.is_dir(),'OUTPUT_PARENT_UNSAFE')
    require(not target.exists() and not target.is_symlink(),'OUTPUT_EXISTS')
    target.mkdir(mode=0o700)
    for name,data in files.items():
        p=target/name;p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with p.open('xb') as f:f.write(data)
        p.chmod(0o600)
    # No hooks/imports from the candidate; re-evaluate the runtime allowlist.
    own,pkg,_=bundle_manifest(target/'bundle')
    require(pkg['version']==manifest['version'],'MANIFEST_PACKAGE_MISMATCH')
    return {'destination':str(target),'fileCount':len(files),'contentVerified':True,'installed':False,'published':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='op',required=True)
    b=sub.add_parser('build');b.add_argument('--candidate',type=Path,required=True);b.add_argument('--output',type=Path,required=True)
    v=sub.add_parser('verify');v.add_argument('--archive',type=Path,required=True);v.add_argument('--sha256',required=True)
    a=parser.parse_args()
    try:print(json.dumps(build(a.candidate,a.output) if a.op=='build' else verify(a.archive,a.sha256),ensure_ascii=False,indent=2))
    except PlanError as e:print(json.dumps({'error':str(e),'installed':False,'published':False}));raise SystemExit(2)
