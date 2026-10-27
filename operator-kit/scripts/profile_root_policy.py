"""Read-only proof of the reviewed DSH generated-root startup contract.

No DSH module is imported or booted. macOS needs Electron's fs reader for ASAR;
Linux reads the installed CLI files directly. Unknown launchers fail closed.
"""
from pathlib import Path
import hashlib,json,subprocess,sys

VERSION='0.2.1-rc.2'
BOOT_SHA='32d6345d7457e7c19c18bad07a85856e7ef7c560d52a1da042d68981ee127b4d'
DESKTOP_SHA='6ae7cb9d57516b73c8aa4317c514ed81d28f2680efcee56d8faf2e588bb28c48'
DESKTOP='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
READER=r"""
const fs=require('fs'),crypto=require('crypto');
const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
console.log(JSON.stringify({version:JSON.parse(fs.readFileSync(root+'/dsh/package.json')).version,
 boot:hash(root+'/dsh/lib/profile-boot-C14i-8IN.js'),
 desktopVersion:JSON.parse(fs.readFileSync(root+'/dsh-desktop-host/package.json')).version,
 desktop:hash(root+'/dsh-desktop-host/lib/index.js')}));
"""

def runtime_observation():
    if sys.platform=='darwin':
        p=subprocess.run([DESKTOP,'-e',READER],env={'ELECTRON_RUN_AS_NODE':'1'},capture_output=True,text=True,timeout=10)
        if p.returncode:raise ValueError('reader failed')
        return json.loads(p.stdout)
    if sys.platform=='linux':
        root=Path('/usr/local/lib/node_modules/@deepseek-ai/dsh')
        if Path('/usr/local/bin/dsh').resolve()!=root/'lib/bin.js':raise ValueError('unknown launcher')
        return {'version':json.loads((root/'package.json').read_text())['version'],
                'boot':hashlib.sha256((root/'lib/profile-boot-C14i-8IN.js').read_bytes()).hexdigest()}
    raise ValueError('unreviewed platform')

def profile_root_contract():
    from upgrade_plan import require,PlanError
    try:observed=runtime_observation()
    except (OSError,ValueError,KeyError,subprocess.SubprocessError):
        raise PlanError('PROFILE_ROOT_CONTRACT_UNVERIFIED') from None
    require(observed.get('version')==VERSION and observed.get('boot')==BOOT_SHA,
            'PROFILE_ROOT_CONTRACT_UNVERIFIED')
    if sys.platform=='darwin':
        require(observed.get('desktopVersion')==VERSION and observed.get('desktop')==DESKTOP_SHA,
                'PROFILE_ROOT_CONTRACT_UNVERIFIED')
    return {'schema':1,'hostVersion':VERSION,'startupSourceSha256':BOOT_SHA,
            'desktopHostSourceSha256':DESKTOP_SHA if sys.platform=='darwin' else None,
            'mode':'host-regenerated-root','source':'bundle/profile/home/explicit patch layers',
            'operatorMayRewriteRoot':False}
