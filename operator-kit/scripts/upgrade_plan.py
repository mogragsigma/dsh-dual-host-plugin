"""Read-only own-plugin upgrade planning. Never import DSH, execute YAML, or write a target."""
from pathlib import Path
import argparse, hashlib, json, re, stat
import yaml
from profile_root_policy import profile_root_contract

STR = 'tag:yaml.org,2002:str'
HEADINGS = {'## 双端协作（本地鱼 / 云端鱼）', '## 双端协作（全局托管规则）'}
MAX_FILE = 8 * 1024 * 1024

class PlanError(ValueError):
    pass

def require(value, code):
    if not value:
        raise PlanError(code)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def version_key(value):
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*))?', value)
    require(match is not None, 'VERSION_INVALID')
    pre = match[4]
    parts = []
    for item in pre.split('.') if pre else []:
        require(not item.isdigit() or item == str(int(item)), 'VERSION_INVALID')
        parts.append((0,int(item)) if item.isdigit() else (1,item))
    return (*(int(match[i]) for i in (1,2,3)), 0 if pre else 1, tuple(parts))

def target_path(home, path):
    require(path.is_absolute() and path.is_relative_to(home) and '..' not in path.parts, 'TARGET_OUTSIDE_HOME')
    for part in [path, *path.parents]:
        if part == home:
            break
        require(not part.is_symlink(), 'SYMLINK_PATH')
        require(not part.exists() or part == path or part.is_dir(), 'TARGET_PARENT_NOT_DIRECTORY')

def read(path):
    path = Path(path)
    require(not path.is_symlink() and path.resolve() == path.absolute(), 'SYMLINK_PATH')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_FILE, 'UNSAFE_FILE')
    data = path.read_bytes()
    require(len(data) <= MAX_FILE, 'FILE_TOO_LARGE')
    return data

def parse(data):
    try:
        node = yaml.compose(data)
    except yaml.YAMLError:
        raise PlanError('YAML_INVALID') from None
    seen = set()
    def visit(n):
        require(n is not None and id(n) not in seen, 'YAML_ALIAS_OR_EMPTY')
        seen.add(id(n))
        if isinstance(n, yaml.MappingNode):
            keys = []
            for k, v in n.value:
                require(isinstance(k, yaml.ScalarNode) and k.tag == STR, 'YAML_MAPPING_KEY')
                require(k.value not in keys, 'YAML_DUPLICATE_KEY')
                keys.append(k.value)
                visit(k); visit(v)
        elif isinstance(n, yaml.SequenceNode):
            for v in n.value:
                visit(v)
        else:
            require(isinstance(n, yaml.ScalarNode), 'YAML_NODE')
    visit(node)
    return node

def walk(node):
    yield node
    if isinstance(node, yaml.MappingNode):
        for k, v in node.value:
            yield from walk(k); yield from walk(v)
    elif isinstance(node, yaml.SequenceNode):
        for v in node.value:
            yield from walk(v)

def fields(node):
    require(isinstance(node, yaml.MappingNode), 'YAML_MAPPING_REQUIRED')
    return {k.value: v for k, v in node.value}

def scalar(node, kind='str'):
    require(isinstance(node, yaml.ScalarNode) and node.tag == 'tag:yaml.org,2002:' + kind, 'STATIC_CONFIG_REQUIRED')
    if kind == 'bool':
        require(node.value.lower() in ('true', 'false'), 'STATIC_CONFIG_REQUIRED')
        return node.value.lower() == 'true'
    if kind == 'int':
        require(re.fullmatch(r'[0-9]+', node.value), 'STATIC_CONFIG_REQUIRED')
        return int(node.value)
    return node.value

def managed_span(text):
    """Only complete top-level headings outside fences; ambiguity never erases user memory."""
    sections = []
    offset = 0
    fence = None
    for line in text.splitlines(keepends=True):
        stripped = line.rstrip('\r\n')
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', stripped)
        if marker:
            chars = marker.group(1)
            if fence is None:
                fence = chars
            elif chars[0] == fence[0] and len(chars) >= len(fence) and not stripped[marker.end():].strip():
                fence = None
        elif fence is None and stripped.startswith('## '):
            sections.append((offset, stripped))
        offset += len(line)
    require(fence is None, 'GLOBAL_UNCLOSED_FENCE')
    owned = [i for i, (_, h) in enumerate(sections) if h in HEADINGS]
    require(len(owned) <= 1, 'GLOBAL_AMBIGUOUS_SECTION')
    if not owned:
        return None
    i = owned[0]
    return sections[i][0], sections[i+1][0] if i+1 < len(sections) else len(text)

def role_block(template, role):
    require(role in ('local', 'cloud'), 'ROLE_INVALID')
    block = template.replace('__HOST_ROLE__', role).replace('__HOST_NAME__', '本地大肥鱼' if role == 'local' else '云端大肥鱼')
    span = managed_span(block)
    require(span == (0, len(block)), 'TEMPLATE_SCOPE')
    return block

def merge_global(original, old_template, new_template, role):
    before = role_block(old_template, role).rstrip()
    block = role_block(new_template, role).rstrip()
    span = managed_span(original)
    require(span is not None, 'GLOBAL_MANAGED_SECTION_MISSING')
    start, end = span
    require(original[start:end].rstrip() == before, 'GLOBAL_MANAGED_SECTION_DRIFT')
    trailing = original[start:end][len(before):]
    return original[:start] + block + trailing + original[end:]

def bundle_manifest(root):
    root = Path(root).absolute()
    require(root.resolve() == root, 'BUNDLE_SYMLINK')
    pkg = json.loads(read(root/'package.json'))
    declared = pkg.get('files')
    supported = {'*.js','cordis.patch.yml','skills','rules','worker-rules','native-rules','global-rules',
                 'compatibility.json','approval-ui','package-lock.json','workbench-assets','development-rules',
                 'delivery-process.py'}
    require(isinstance(declared, list) and all(isinstance(x,str) and x in supported for x in declared), 'BUNDLE_FILE_DECLARATION')
    if 'delivery-process.py' in declared:
        require((root/'delivery-process.py').is_file(), 'BUNDLE_SUPERVISOR_MISSING')
    result = {}
    def descend(folder):
        for path in sorted(folder.iterdir()):
            rel = path.relative_to(root).as_posix()
            if rel == 'node_modules':
                continue
            require(not path.is_symlink(), 'BUNDLE_SYMLINK')
            require(not path.name.startswith('.'), 'BUNDLE_UNEXPECTED_FILE')
            if folder == root:
                require(rel == 'package.json' or rel in declared or '*.js' in declared and path.is_file() and path.suffix == '.js', 'BUNDLE_UNDECLARED_FILE')
            require(path.name not in {'.git', 'private', '.env', '__pycache__', '.DS_Store'}, 'BUNDLE_UNEXPECTED_FILE')
            if path.is_dir():
                descend(path)
            else:
                require(path.suffix not in {'.sqlite', '.db', '.pem', '.key', '.token'}, 'BUNDLE_PRIVATE_FILE')
                result[rel] = sha(read(path))
    descend(root)
    require('package.json' in result and 'compatibility.json' in result, 'BUNDLE_METADATA_REQUIRED')
    compat = json.loads(read(root/'compatibility.json'))
    require(pkg.get('name') == '@local/dsh-task-gateway' and pkg.get('version') == compat.get('version'), 'BUNDLE_VERSION_MISMATCH')
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', pkg['version']), 'VERSION_INVALID')
    lock = json.loads(read(root/'package-lock.json'))
    require(lock.get('version') == pkg['version'], 'LOCK_VERSION_MISMATCH')
    require(lock.get('packages', {}).get('', {}).get('dependencies') == pkg.get('dependencies'), 'LOCK_DEPENDENCY_MISMATCH')
    # Reject a broken owned section before packaging, not only during deployment.
    template = read(root/'global-rules/AGENTS.md').decode('utf-8')
    for role in ('local', 'cloud'):
        role_block(template, role)
    return result, pkg, compat

def materials(home, profile, candidate):
    """Operator-only in-memory payloads; the public plan never returns these bytes."""
    home, candidate = Path(home).absolute(), Path(candidate).absolute()
    require(home.resolve() == home and re.fullmatch(r'[A-Za-z0-9_-]+', profile), 'HOME_OR_PROFILE_INVALID')
    prof = home/'profiles'/profile
    patch = prof/'cordis.patch.yml'
    raw = read(patch).decode('utf-8')
    tree = parse(raw)
    candidates = []
    for n in walk(tree):
        if isinstance(n, yaml.MappingNode):
            f = fields(n)
            name = f.get('name')
            if isinstance(name, yaml.ScalarNode) and name.tag == STR and name.value.startswith(str(home/'task-gateway')+'/') and name.value.endswith('/bundle/native-entry.js'):
                candidates.append(f)
    require(len(candidates) == 1, 'OWN_ENTRY_AMBIGUOUS')
    entry = candidates[0]
    old = Path(scalar(entry['name'])).parent
    old_manifest, old_pkg, old_compat = bundle_manifest(old)
    new_manifest, pkg, compat = bundle_manifest(candidate)
    require(pkg['version'] != old_pkg['version'], 'SAME_VERSION')
    require(version_key(pkg['version']) > version_key(old_pkg['version']), 'DOWNGRADE_REQUIRES_ROLLBACK_REVIEW')
    target = home/'task-gateway'/('v'+pkg['version'])/'bundle'
    target_path(home, target)
    require(not target.parent.exists() and not target.parent.is_symlink(), 'TARGET_EXISTS')
    c = fields(entry['config'])
    role = scalar(c.get('role'))
    require(role in ('local','cloud'), 'ROLE_INVALID')
    require('legacyFeishu' in c and scalar(c['legacyFeishu'], 'bool') is False, 'LEGACY_CONSUMER')
    if 'entryMode' in c:
        require(scalar(c['entryMode']) == 'native', 'NON_NATIVE_ENTRY')
    if 'development' in c:
        dev = fields(c['development'])
        require('enabled' not in dev or scalar(dev['enabled'], 'bool') is False, 'DEVELOPMENT_MUST_STAY_CLOSED')
    if 'delivery' in c:
        delivery = fields(c['delivery'])
        require('execute' not in delivery or scalar(delivery['execute'], 'bool') is False,
                'DELIVERY_EXECUTION_MUST_STAY_CLOSED')
        if 'push' in delivery:
            push = fields(delivery['push'])
            require('execute' not in push or scalar(push['execute'], 'bool') is False,
                    'DELIVERY_EXECUTION_MUST_STAY_CLOSED')
    state = Path(scalar(c.get('stateDir')))
    require(state.is_absolute() and state.resolve() == state and state.is_relative_to(home/'task-gateway'), 'STATE_PATH_UNREVIEWED')
    # No constructor/import of runtime: inspection cannot migrate a live database.
    lock_port = None
    if 'scheduler' in c:
        sc = fields(c['scheduler']); lock_port = scalar(sc.get('lockPort'), 'int')
        require(1 <= lock_port <= 65535 and role == 'cloud', 'SCHEDULER_CONFIG_INVALID')
    allowed = {'native-entry.js','native-tools.js','worker-tools.js','skills'}
    replacements = []
    paths = []
    for n in walk(tree):
        if isinstance(n, yaml.ScalarNode) and str(old) in n.value:
            require(n.tag == STR and n.value.startswith(str(old)+'/'), 'EMBEDDED_BUNDLE_REFERENCE')
            suffix = n.value[len(str(old))+1:]
            require(suffix in allowed, 'UNREVIEWED_BUNDLE_REFERENCE')
            require((candidate/suffix).exists(), 'CANDIDATE_ENTRY_MISSING')
            fragment = raw[n.start_mark.index:n.end_mark.index]
            require(fragment.count(str(old)) == 1, 'REFERENCE_ENCODING_UNSUPPORTED')
            replacements.append((n.start_mark.index,n.end_mark.index,fragment.replace(str(old)+'/', str(target)+'/')))
            paths.append(suffix)
    require(sorted(paths) == sorted(['native-entry.js','native-tools.js'] + (['worker-tools.js','skills'] if role == 'cloud' else [])), 'PROFILE_LAYOUT_UNREVIEWED')
    rewritten = raw
    for start,end,text in sorted(replacements, reverse=True):
        rewritten = rewritten[:start] + text + rewritten[end:]
    # Reviewed DSH boots regenerate a materialized root from the patch stack.
    # Never edit that runtime cache or mistake it for a second source of plugins.
    root_file=prof/'cordis.yml'
    root_bytes=read(root_file)
    root_tree=parse(root_bytes)
    generated_root=None
    if not (isinstance(root_tree,yaml.SequenceNode) and not root_tree.value):
        generated_root={'path':str(root_file.relative_to(home)),
                        'mode':'host-regenerated-root','observed_sha256':sha(root_bytes),
                        'contract':profile_root_contract()}
    originals = {str(p.relative_to(home)):sha(read(p)) for p in [prof/'cordis.yml',prof/'package.json',patch]}
    if generated_root:originals.pop(str(root_file.relative_to(home)))
    # The home patch outranks the profile patch. Do not overlook an effective
    # override or let a newly created layer appear between plan and application.
    home_patch=home/'cordis.patch.yml'
    target_path(home,home_patch)
    home_bytes=read(home_patch) if home_patch.exists() else None
    if home_bytes is not None:
        home_tree=parse(home_bytes)
        require(isinstance(home_tree,yaml.SequenceNode) and not home_tree.value,'HOME_PATCH_REQUIRES_REVIEW')
    originals['cordis.patch.yml']=sha(home_bytes) if home_bytes is not None else None
    profile_package = json.loads(read(prof/'package.json'))
    for registered in profile_package.get('dsh', {}).get('profile', {}).get('bundles', []):
        require(isinstance(registered, str) and str(old) not in registered and registered != pkg['name'], 'OWN_ENTRY_OUTSIDE_PATCH')
    old_config = old.parent/'config.json'
    originals[str(old_config.relative_to(home))] = sha(read(old_config))
    global_file = home/'AGENTS.md'
    global_bytes = read(global_file)
    merged = merge_global(global_bytes.decode(),read(old/'global-rules/AGENTS.md').decode(),read(candidate/'global-rules/AGENTS.md').decode(),role).encode()
    changes = [{'path':str(patch.relative_to(home)),'before':sha(raw.encode()),'after':sha(rewritten.encode()),'kind':'own-entry-paths'},
               {'path':'AGENTS.md','before':sha(global_bytes),'after':sha(merged),'kind':'global-managed-block'}]
    payloads = {str(patch.relative_to(home)):rewritten.encode(), 'AGENTS.md':merged}
    old_skills, new_skills = old_compat['globalSkills'], compat['globalSkills']
    require(len(set(new_skills)) == len(new_skills) and set(old_skills) <= set(new_skills), 'SKILL_REMOVAL_REQUIRES_REVIEW')
    for name in new_skills:
        require(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name), 'SKILL_NAME_INVALID')
        # Current release consists of SKILL.md files. Never silently skip new assets.
        sources = [x.relative_to(candidate/'skills'/name).as_posix() for x in (candidate/'skills'/name).rglob('*') if x.is_file()]
        require(sources == ['SKILL.md'], 'SKILL_ASSETS_REQUIRE_REVIEW')
        installed = home/'skills'/name/'SKILL.md'
        target_path(home, installed)
        before = read(installed) if installed.exists() else None
        after = read(candidate/'skills'/name/'SKILL.md')
        if name in old_skills:
            require(before == read(old/'skills'/name/'SKILL.md'), 'INSTALLED_SKILL_DRIFT')
        else:
            require(before is None or before == after, 'SKILL_NAME_COLLISION')
        changes.append({'path':str(installed.relative_to(home)),'before':sha(before) if before is not None else None,'after':sha(after),'kind':'global-skill'})
        payloads[str(installed.relative_to(home))] = after
    result = {'schema':1,'mode':'read-only-plan','execution':False,'role':role,'profile':profile,
              'source_version':old_pkg['version'],'candidate_version':pkg['version'],
              'source_bundle_sha256':sha(json.dumps(old_manifest,sort_keys=True,separators=(',',':')).encode()),
              'candidate_bundle_sha256':sha(json.dumps(new_manifest,sort_keys=True,separators=(',',':')).encode()),
              'candidate_files':len(new_manifest),'candidate_dependencies':pkg.get('dependencies',{}),
              'target_relative':str(target.relative_to(home)),'unchanged_inputs':originals,'changes':changes,
              'state_relative':str(state.relative_to(home)),'prior_scheduler_lock_port':lock_port,
              'config_policy':'effective existing config preserved; no capability activation',
              'requires':['explicit operator deployment decision','fresh idle-and-stopped verification','consistent backups and current-state compare','dependency materialization/integrity','legacy scheduler owner migration if absent','rollback compatibility audit; never restore old databases automatically'],
              'host_stopped_verified':False,'backup_created':False,'may_apply':False}
    if generated_root:result['profile_root']=generated_root
    result['fingerprint'] = sha(json.dumps(result,sort_keys=True,separators=(',',':')).encode())
    return result, payloads, old

def plan(home, profile, candidate):
    """Return only hashes/relative paths, never configuration text or credentials."""
    return materials(home, profile, candidate)[0]

if __name__ == '__main__':
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--home',required=True,type=Path);cli.add_argument('--profile',required=True);cli.add_argument('--candidate',required=True,type=Path)
    args=cli.parse_args()
    try:
        print(json.dumps(plan(args.home,args.profile,args.candidate),ensure_ascii=False,indent=2))
    except PlanError as e:
        print(json.dumps({'mode':'read-only-plan','execution':False,'may_apply':False,'error':str(e)}));raise SystemExit(2)
