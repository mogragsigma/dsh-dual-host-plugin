"""Explicit, append-only patch rollback review. Parse YAML; never evaluate it.

Preserve current bytes except the original transaction's own path substitutions.
Existing patch entries must be semantically unchanged. New top-level entries must
be static and cannot refer to the project or collide with an existing plugin ID.
This is not a general three-way merge or permission to discard configuration.
"""
import json
import yaml
from upgrade_plan import parse, walk, fields, scalar, STR, sha, require


def shape(node):
    if isinstance(node, yaml.MappingNode):
        return [node.tag, sorted((k.value, shape(v)) for k, v in node.value)]
    if isinstance(node, yaml.SequenceNode):
        return [node.tag, [shape(v) for v in node.value]]
    return [node.tag, node.value]


def fingerprint(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def review(manifest, proof, row, before, after, current):
    require(row['kind'] == 'own-entry-paths' and row['before'] is not None, 'PATCH_REVIEW_SCOPE')
    require(sha(before) == row['before'] and sha(after) == row['after'], 'PATCH_REVIEW_BACKUP_CHANGED')
    require(current not in (before, after), 'PATCH_REVIEW_NOT_NEEDED')
    old = manifest['home'] + '/task-gateway/v' + manifest['plan']['source_version'] + '/bundle'
    new = manifest['home'] + '/' + manifest['plan']['target_relative']
    originals = [parse(x) for x in (before, after, current)]
    require(all(isinstance(x, yaml.SequenceNode) for x in originals), 'PATCH_REVIEW_SEQUENCE_REQUIRED')
    b, a, c = [x.value for x in originals]
    require(len(a) == len(b) and len(c) >= len(a), 'PATCH_REVIEW_EXISTING_ENTRIES_CHANGED')
    require([shape(x) for x in c[:len(a)]] == [shape(x) for x in a], 'PATCH_REVIEW_EXISTING_ENTRIES_CHANGED')
    ids = set()
    for node in walk(originals[1]):
        if isinstance(node, yaml.MappingNode) and 'id' in fields(node):
            ids.add(scalar(fields(node)['id']))
    extra_ids = set()
    for entry in c[len(a):]:
        require(isinstance(entry, yaml.MappingNode), 'PATCH_REVIEW_STATIC_ADDITION_REQUIRED')
        for node in walk(entry):
            require(node.tag.startswith('tag:yaml.org,2002:') and node.tag.rsplit(':', 1)[-1] in
                    {'map', 'seq', 'str', 'bool', 'int', 'float', 'null'}, 'PATCH_REVIEW_STATIC_ADDITION_REQUIRED')
            if isinstance(node, yaml.ScalarNode):
                require(manifest['home'] + '/task-gateway' not in node.value and
                        '@local/dsh-task-gateway' not in node.value and node.value not in ids,
                        'PATCH_REVIEW_ADDITION_COLLISION')
            if isinstance(node, yaml.MappingNode) and 'id' in fields(node):
                value = scalar(fields(node)['id'])
                require(value not in extra_ids, 'PATCH_REVIEW_ADDITION_COLLISION')
                extra_ids.add(value)
    text = current.decode('utf-8')
    substitutions = []
    for entry in c[:len(a)]:
        for node in walk(entry):
            if isinstance(node, yaml.ScalarNode) and new in node.value:
                require(node.tag == STR and node.value.startswith(new + '/') and
                        node.value[len(new) + 1:] in {'native-entry.js', 'native-tools.js', 'worker-tools.js', 'skills'},
                        'PATCH_REVIEW_REFERENCE_INVALID')
                fragment = text[node.start_mark.index:node.end_mark.index]
                # DSH may serialize a long quoted path with escaped line breaks.
                # The decoded scalar is already checked against the exact owned
                # reference. JSON quoting is also a safe YAML string literal;
                # only this scalar is normalized, never the surrounding config.
                replacement = (fragment.replace(new + '/', old + '/') if fragment.count(new) == 1
                               else json.dumps(old + node.value[len(new):], ensure_ascii=False))
                substitutions.append((node.start_mark.index, node.end_mark.index, replacement))
    expected = 4 if manifest['plan']['role'] == 'cloud' else 2
    require(len(substitutions) == expected, 'PATCH_REVIEW_REFERENCE_COUNT')
    for start, end, replacement in sorted(substitutions, reverse=True):
        text = text[:start] + replacement + text[end:]
    merged = parse(text).value
    require([shape(x) for x in merged[:len(b)]] == [shape(x) for x in b] and
            [shape(x) for x in merged[len(b):]] == [shape(x) for x in c[len(a):]], 'PATCH_REVIEW_REVERSE_MISMATCH')
    output = text.encode('utf-8')
    plan = {'schema': 1, 'kind': 'explicit-append-only-patch-rollback', 'transactionFingerprint': proof,
            'path': row['path'], 'inputSHA256': sha(current), 'outputSHA256': sha(output),
            'preservedAppendedEntries': len(c) - len(a), 'ownReferencesReverted': len(substitutions),
            'databaseRestore': False, 'hostStarted': False}
    plan['fingerprint'] = fingerprint(plan)
    return plan, output
