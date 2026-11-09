"""Named current-policy / historical-compatibility regressions, isolation only.

The launcher owns network permissions and credential exclusion. This script does
not start native Hosts, fetch dependencies, call models, or write Git repositories.
Frozen release assertions remain archival and cannot be selected here.
"""
from pathlib import Path
import argparse,json,os,subprocess
ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--set',required=True,choices=['current-policy','historical-compatibility','ui-current']);a=parser.parse_args()
 home=Path(os.environ.get('DSH_HOME','/missing')).parent.resolve()
 assert Path(os.environ['HOME'])==home/'home' and Path(os.environ['DSH_AGENTS_HOME'])==home/'agents','Use the isolated launcher'
 assert ROOT.is_relative_to(home/'workspace'),'Run the frozen isolated candidate, not a production install'
 assert os.environ.get('DSH_TEST_PORT_BASE','').isdigit(),'Explicit isolated fixture port base is required'
 tests=json.loads((ROOT/'scripts/v2-acceptance-sets.json').read_text())['sets'][a.set]['files']
 subprocess.run(['python3',str(ROOT/'scripts/build-module-index.py'),'--check'],check=True)
 raise SystemExit(subprocess.call(['node','--test','--test-reporter=tap','--test-concurrency=1',*[str(ROOT/'tests'/name) for name in tests]],cwd=ROOT))
