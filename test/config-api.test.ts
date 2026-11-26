import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../../dsh-loader/dist/services/config.js';
import { createPatchAPI } from '@dsh-plugin/dsh-loader/patch';
import { apply, Config } from '../lib/index.js';

const policyId = 'dsh-network-settings-policy';
const connectionId = 'dsh-network-settings-connection';

test('迁移旧网络设置后，分别保存策略与代理凭据并保留重载前的修改', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'network-config-v2-'));
  const configFile = (id: string) => join(directory, 'config', id, 'config.json');
  const legacyId = 'dsh-network-settings';
  const legacy = JSON.stringify({
    formatVersion: 1,
    revision: 1,
    value: {
      userAgent: 'migrated-test',
      proxyTimeoutMs: 60000,
      proxyUsername: 'legacy-user',
      proxyPassword: 'legacy-secret',
    },
  });
  await mkdir(join(directory, 'config', legacyId), { recursive: true });
  await writeFile(configFile(legacyId), legacy);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const store = new ConfigStore(directory);
  const releases: (() => void)[] = [];
  const unload = () => {
    for (const off of releases.splice(0).reverse()) {
      off();
    }
  };
  const routes = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Response(new Headers(init?.headers).get('user-agent'));
  const native = globalThis.fetch;
  const ctx: any = {
    effect(fn: () => (() => void) | void) { const off = fn(); if (off) releases.push(off); },
    logger: { info() {}, warn() {}, error() {} },
    dshLoader: {
      config: store, patch: createPatchAPI(),
      services: { get: (name: string) => name === 'webServer' ? {} : undefined },
      web: { exact(path: string, handler: unknown) { routes.set(path, handler); return () => routes.delete(path); } },
    },
  };
  try {
    await apply(ctx, Config({ userAgent: 'initial-test', retryEnabled: false }));
    assert.equal(await (await fetch('http://example.invalid')).text(), 'migrated-test');
    assert.deepEqual(store.list().map(view => view.template.id).sort(), [connectionId, policyId]);
    const policy = store.read(policyId);
    const connection = store.read(connectionId);
    assert.equal(policy.template.packageName, '@dsh-plugin/dsh-network-settings');
    assert.equal(connection.template.packageName, policy.template.packageName);
    assert.equal(policy.value.requestIdleTimeoutMs, 240000);
    assert.equal(policy.value.proxyTimeoutMs, 60000);
    assert.equal(connection.value.proxyUsername, 'legacy-user');
    assert(!JSON.stringify(connection).includes('legacy-secret'));
    const migrated = JSON.parse(await readFile(configFile(connectionId), 'utf8'));
    assert.equal(migrated.value.proxyPassword, 'legacy-secret');
    assert(!routes.has('/_dsh/dsh-network-settings/settings'));

    await store.write(policyId, { userAgent: 'updated-test' }, policy.revision);
    await store.write(connectionId, { proxyPassword: 'updated-secret' }, connection.revision);
    assert.equal(await (await fetch('http://example.invalid')).text(), 'updated-test');
    assert(!JSON.stringify(store.read(connectionId)).includes('updated-secret'));
    const savedPolicy = JSON.parse(await readFile(configFile(policyId), 'utf8'));
    assert.equal(savedPolicy.value.userAgent, 'updated-test');
    assert(!Object.hasOwn(savedPolicy.value, 'proxyUsername'));
    assert(!Object.hasOwn(savedPolicy.value, 'proxyPassword'));
    const savedConnection = JSON.parse(await readFile(configFile(connectionId), 'utf8'));
    assert.equal(savedConnection.value.proxyPassword, 'updated-secret');
    assert(!Object.hasOwn(savedConnection.value, 'userAgent'));

    const captured = globalThis.fetch;
    const foreign = (...args: Parameters<typeof fetch>) => captured(...args);
    globalThis.fetch = foreign;
    unload();
    assert.equal(globalThis.fetch, foreign);
    assert.equal(await (await fetch('http://example.invalid')).text(), '');
    assert.deepEqual(store.list(), []);
    assert.equal(routes.size, 0);
    assert.notEqual(native, captured);

    await mkdir(join(directory, 'config', legacyId), { recursive: true });
    await writeFile(configFile(legacyId), legacy);
    globalThis.fetch = native;
    await apply(ctx, Config({ userAgent: 'different-default', retryEnabled: false }));
    assert.equal(await (await fetch('http://example.invalid')).text(), 'updated-test');
    assert.equal(store.read(policyId).revision, savedPolicy.revision);
    assert.equal(store.read(connectionId).revision, savedConnection.revision);
    assert.equal(JSON.parse(await readFile(configFile(connectionId), 'utf8')).value.proxyPassword, 'updated-secret');
  } finally {
    unload();
    globalThis.fetch = original;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    store.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
