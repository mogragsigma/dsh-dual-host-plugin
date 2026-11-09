"""Explicit 2.0 release collection. Always run through the isolated launcher."""
import argparse,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--list',action='store_true');p.add_argument('--include-git',action='store_true',help='requires separate current approval');p.add_argument('--only',nargs='+');a=p.parse_args()
m=json.loads((ROOT/'docs/release-2.0/acceptance-files.json').read_text());names=sorted(set(m['synthetic']+(m['git_separate'] if a.include_git else [])))
if a.only:
 if not set(a.only)<=set(names):p.error('unknown or unapproved test file')
 names=sorted(set(a.only))
assert names and all((ROOT/'tests'/n).is_file()for n in names)
if a.list:print(json.dumps(names));sys.exit(0)
for k in ['HOME','DSH_HOME','DSH_AGENTS_HOME']:assert os.environ.get(k),k
# Host/test dependencies and OS restrictions belong to the isolated caller.
subprocess.run(['python3',str(ROOT/'scripts/build-module-index.py'),'--check'],check=True)
failures=[]
for name in names:
 r=subprocess.run([os.environ.get('NODE','node'),'--test','--test-concurrency=1',str(ROOT/'tests'/name)],cwd=ROOT)
 if r.returncode:failures.append(name)
print(json.dumps({'files':len(names),'failed_files':failures,'git_set_included':a.include_git}));sys.exit(bool(failures))
