import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../../dsh-loader/dist/services/config.js';
import { createPatchAPI } from '@dsh-plugin/dsh-loader/patch';
import { apply, Config } from '../lib/index.js';
import { createConfigTemplate } from '../lib/config-template.js';

test('config-api persists policies, applies saved edits immediately and releases the fetch layer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'network-config-v2-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const store = new ConfigStore(directory);
  const releases: (() => void)[] = [];
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
    assert.equal(await (await fetch('http://example.invalid')).text(), 'initial-test');
    const view = store.read('dsh-network-settings');
    assert.equal(view.template.packageName, '@dsh-plugin/dsh-network-settings');
    assert.deepEqual(view.template.fields.map(field => field.type), ['group', 'group', 'group']);
    assert(!routes.has('/_dsh/dsh-network-settings/settings'));
    await store.write('dsh-network-settings', { userAgent: 'updated-test', proxyPassword: 'test-secret' }, view.revision);
    assert.equal(await (await fetch('http://example.invalid')).text(), 'updated-test');
    assert(!JSON.stringify(store.read('dsh-network-settings')).includes('test-secret'));
    const file = join(directory, 'config/dsh-network-settings/config.json');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).value.userAgent, 'updated-test');
    const captured = globalThis.fetch;
    const foreign = (...args: Parameters<typeof fetch>) => captured(...args);
    globalThis.fetch = foreign;
    for (const off of releases.reverse()) off();
    assert.equal(globalThis.fetch, foreign);
    assert.equal(await (await fetch('http://example.invalid')).text(), '');
    assert.deepEqual(store.list(), []); assert.equal(routes.size, 0);
    assert.notEqual(native, captured);
    const reloaded = await store.register(ctx, createConfigTemplate(Config({})));
    assert.equal(reloaded.get().value.userAgent, 'updated-test');
    reloaded.dispose();
  } finally {
    globalThis.fetch = original;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    store.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
