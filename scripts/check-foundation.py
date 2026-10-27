"""Check this frozen source export; never install, restart, contact a Host or run Git."""
from pathlib import Path
import ast, hashlib, json, re

ROOT = Path(__file__).resolve().parents[1]

def manifest(root):
    files = {}
    for p in sorted(root.rglob('*')):
        relative = p.relative_to(root)
        if any(x in {'node_modules', '__pycache__', '.DS_Store'} for x in relative.parts):
            continue
        assert not p.is_symlink(), f'Unexpected source symlink: {relative}'
        if p.is_file():
            files[relative.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return files

def inspect(root=ROOT):
    b = root/'bundle'
    p, lock, c = [json.loads((b/n).read_text()) for n in ('package.json', 'package-lock.json', 'compatibility.json')]
    baseline = json.loads((root/'docs/source-bundle-v0.33.0.json').read_text())
    assert p['version'] == lock['version'] == lock['packages']['']['version'] == c['version'] == baseline['version']
    assert lock['packages']['']['dependencies'] == p['dependencies']
    assert p['exports']['.'] == './native-entry.js'
    assert "VERSION='"+p['version']+"'" in (b/'link-contract.js').read_text()
    skills = c['globalSkills'] + [c['workerSkill']]
    assert len(skills) == len(set(skills)) == 20
    for name in skills:
        data = (b/'skills'/name/'SKILL.md').read_text()
        assert data.startswith('---\n') and '\n---' in data[4:]
        front = data.split('---', 2)[1]
        assert re.search(r'^name:\s*[\"\']?'+re.escape(name)+r'[\"\']?\s*$', front, re.M)
        assert re.search(r'^description:\s*\S', front, re.M)
    rules = (b/'global-rules/AGENTS.md').read_text()
    assert '__HOST_NAME__' in rules and '__HOST_ROLE__' in rules
    assert not re.search(r'/Users/|/root/dsh-cloud|BEGIN .*PRIVATE KEY', rules)
    for file in b.glob('*.py'):
        ast.parse(file.read_text())
    files = manifest(b)
    assert files == baseline['manifest'], 'Source export drift: review a new export baseline; never overwrite historical acceptance hashes'
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'version': p['version'], 'files': len(files), 'bundle_sha256': digest,
            'skillsValidated': len(skills), 'frozenBundleMatches': True,
            'formalDeployment': False, 'executionAuthorizedByCheck': False}

if __name__ == '__main__':
    print(json.dumps(inspect(), ensure_ascii=False, indent=2))
