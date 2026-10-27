"""Static navigation aid, not a complete runtime dependency or authorization graph."""
from pathlib import Path
import json, re, sys
ROOT = Path(__file__).resolve().parents[1]

def build():
    modules = {}
    for directory in ('bundle', 'ui-source'):
        for p in sorted((ROOT/directory).rglob('*')):
            if not p.is_file() or 'node_modules' in p.parts or p.suffix not in ('.js', '.jsx', '.mjs', '.py'):
                continue
            rel = p.relative_to(ROOT).as_posix()
            if p.name in ('onboarding.generated.js', 'workbench-client.js') and (directory=='bundle' or p.name=='onboarding.generated.js'):
                continue
            text = p.read_text()
            imports = sorted(set(re.findall(r'(?:from\s*|import\s*)[\"\']([^\"\']+)[\"\']', text)))
            modules[rel] = {'lines': len(text.splitlines()), 'imports': imports,
                'exports': sorted(set(re.findall(r'export\s+(?:(?:async|default)\s+)?(?:function|class|const)\s+(\w+)', text))),
                'referencedByTests': []}
    for p in sorted((ROOT/'tests').glob('*')):
        if not p.is_file() or p.suffix not in ('.js', '.mjs', '.py'): continue
        text = p.read_text()
        for rel, row in modules.items():
            if '../'+rel in text:
                row['referencedByTests'].append(p.relative_to(ROOT).as_posix())
    return json.dumps({'version': json.loads((ROOT/'bundle/package.json').read_text())['version'],
        'scope': 'Static imports/exports and literal test references; dynamic injection and transitive coverage require manual review.',
        'modules': modules}, ensure_ascii=False, indent=2)+'\n'

if __name__ == '__main__':
    path = ROOT/'docs/module-index.json'; result = build()
    if '--check' in sys.argv:
        assert path.read_text()==result, 'Module index stale; run scripts/build-module-index.py'
        print('Module index matches source.')
    else:
        path.write_text(result); print('Module index written.')
