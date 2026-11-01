import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {VERSION} from '../bundle/link-contract.js';

const read = async name => JSON.parse(await fs.readFile(new URL('../' + name, import.meta.url)));
const hostVersion = '0.2.1-rc.5';
const identity = '@mogragsigma/dsh-dual-host-plugin';

test('current root and archive manifests have one release identity and dependency contract', async () => {
  const root = await read('package.json'), bundle = await read('bundle/package.json');
  assert.equal(root.name, identity);
  assert.equal(root.version, '0.33.3');
  assert.equal(VERSION, root.version);
  for (const key of ['name', 'version', 'dependencies', 'peerDependencies', 'peerDependenciesMeta',
    'engines', 'dsh', 'author', 'license', 'publishConfig']) assert.deepEqual(bundle[key], root[key], key);
  assert.equal(root.private, false);
  assert.equal(bundle.private, undefined);
  assert.equal(root.scripts, undefined);
  assert.equal(bundle.scripts, undefined);
  for (const manifest of ['compatibility.json', 'bundle/compatibility.json']) {
    const c = await read(manifest);
    assert.equal(c.version, root.version);
    assert.equal(c.plugin, identity);
    assert.equal(c.hostBaseline, hostVersion);
    assert.equal(c.publish, true);
  }
  for (const [key, entry] of Object.entries(bundle.exports)) {
    assert.equal(root.exports[key], key === './package.json' ? './package.json' : entry.replace('./', './bundle/'));
  }
});

test('Host-owned packages are optional peers, never installed as private stale copies', async () => {
  for (const file of ['package.json', 'bundle/package.json']) {
    const p = await read(file);
    assert(!Object.keys(p.dependencies).some(n => n.startsWith('@deepseek-ai/')));
    for (const name of ['agent', 'credentials', 'http-proxy', 'web-fetch-http',
      'web-search-deepseek', 'llm', 'llm-deepseek', 'llm-pi-ai']) {
      const key = '@deepseek-ai/dsh-' + name;
      assert.equal(p.peerDependencies[key], hostVersion);
      assert.deepEqual(p.peerDependenciesMeta[key], {optional: true});
    }
  }
  for (const file of ['package-lock.json', 'bundle/package-lock.json']) {
    const lock = await read(file), p = await read(file.replace('package-lock', 'package'));
    assert.equal(lock.version, p.version);
    assert.equal(lock.packages[''].version, p.version);
    assert.deepEqual(lock.packages[''].dependencies, p.dependencies);
    assert.deepEqual(lock.packages[''].peerDependencies, p.peerDependencies);
    assert(!Object.keys(lock.packages).some(n => n.includes('node_modules/@deepseek-ai/')));
  }
});

test('managed standalone runtime matches declared Host, not historical rc.3', async () => {
  const compat = await read('bundle/compatibility.json');
  for (const prefix of ['runtime', 'runtime-im']) {
    const pkg = await read(`bundle/${prefix}-package.json`);
    const lock = await read(`bundle/${prefix}-lock.json`);
    assert.equal(pkg.dependencies['@deepseek-ai/dsh'], hostVersion);
    assert.equal(lock.packages['node_modules/@deepseek-ai/dsh'].version, hostVersion);
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
    assert(!pkg.scripts);
    for (const [name, dep] of Object.entries(lock.packages)) {
      if (/node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(name)) assert.equal(dep.version, hostVersion, name);
    }
    if (prefix === 'runtime-im') assert.equal(pkg.dependencies['@xmanrui/dsh-im'], compat.imOptional.installationVersion);
    else assert(!pkg.dependencies['@xmanrui/dsh-im']);
  }
});

test('current UI and patch identities agree and historical manifests stay historical', async () => {
  for (const name of ['cordis.patch.yml', 'bundle/cordis.patch.yml', 'ui-source/workbench-client.js',
    'bundle/workbench-client.js', 'bundle/onboarding-self-lifecycle.js']) {
    const text = await fs.readFile(new URL('../' + name, import.meta.url), 'utf8');
    assert(text.includes(identity), name);
    assert(!text.includes('@local/dsh-task-gateway'), name);
  }
  const history = await read('docs/source-bundle-v0.33.0.json');
  assert(history);
  const current = await read('docs/module-index.json');
  assert.equal(current.version, VERSION);
});
