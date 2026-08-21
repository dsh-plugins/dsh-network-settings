/**
 * 旧 net-proxy.json 迁移与配置投影测试（node --test，TypeScript 源）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyProxyMerge, Config } from '../lib/index.js';
import { loadConfig, writeConfig, toCfg, toProxy, configPath } from '../lib/legacy-config.js';

test('loadConfig：文件缺失 → 默认值；文件存在 → 合并默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dns-legacy-'));
  const file = join(dir, 'net-proxy.json');
  try {
    assert.equal(existsSync(file), false);
    assert.deepEqual(loadConfig(file), {
      enabled: false,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      username: '',
      password: '',
      noProxy: ['127.0.0.1', 'localhost', '::1'],
    });
    writeFileSync(file, JSON.stringify({ enabled: true, host: '10.0.0.1', port: 8888 }), 'utf8');
    const loaded = loadConfig(file);
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.host, '10.0.0.1');
    assert.equal(loaded.port, 8888);
    assert.equal(loaded.protocol, 'http', '未提供的字段回退默认');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeConfig → loadConfig 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dns-legacy-'));
  const file = join(dir, 'net-proxy.json');
  try {
    const written = writeConfig({ enabled: true, protocol: 'socks5', noProxy: ['example.com'] }, file);
    assert.equal(written.enabled, true);
    assert.deepEqual(loadConfig(file), {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 7890,
      username: '',
      password: '',
      noProxy: ['example.com'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toCfg / toProxy 投影', () => {
  const cfg = toCfg({ protocol: 'socks5', host: 'h', port: 1080, username: 'u', password: 'p' });
  assert.equal(cfg.enabled, false);
  const proxy = toProxy(cfg);
  assert.deepEqual(proxy, {
    protocol: 'socks5',
    host: 'h',
    port: 1080,
    username: 'u',
    password: 'p',
    noProxy: ['127.0.0.1', 'localhost', '::1'],
  });
  // noProxy 空 → 兜底回环列表
  assert.deepEqual(toProxy({ noProxy: [] }).noProxy, ['127.0.0.1', 'localhost', '::1']);
  // 空凭据 → undefined（不发送 Proxy-Authorization）
  const empty = toProxy({});
  assert.equal(empty.username, undefined);
  assert.equal(empty.password, undefined);
});

test('legacyProxyMerge：旧文件代理字段并入 base（用户保存值仍优先由 settings 层保证）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dns-legacy-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    writeFileSync(join(dir, 'net-proxy.json'), JSON.stringify({ enabled: true, host: 'proxy.example', port: 3128, noProxy: ['abc.test'] }), 'utf8');
    assert.equal(configPath(), join(dir, 'net-proxy.json'));
    const merged = legacyProxyMerge({
      uaEnabled: true,
      userAgent: 'entry-ua',
      proxyEnabled: false,
      proxyProtocol: 'http',
      proxyHost: 'entry-host',
      proxyPort: 1,
      proxyUsername: '',
      proxyPassword: '',
      proxyNoProxy: ['entry.test'],
      proxyTimeoutMs: 5000,
      retryEnabled: true,
      maxRetries: 2,
    } as never);
    // 迁移字段覆盖 entry
    assert.equal(merged.proxyEnabled, true);
    assert.equal(merged.proxyHost, 'proxy.example');
    assert.equal(merged.proxyPort, 3128);
    assert.deepEqual(merged.proxyNoProxy, ['abc.test']);
    // 与代理无关的字段保持 entry
    assert.equal(merged.uaEnabled, true);
    assert.equal(merged.userAgent, 'entry-ua');
    assert.equal(merged.proxyTimeoutMs, 5000);
    assert.equal(merged.maxRetries, 2);
  } finally {
    delete process.env.DSH_HOME;
    if (originalHome !== undefined) process.env.DSH_HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacyProxyMerge：无旧文件时返回原样 entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dns-legacy-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const entry: Record<string, unknown> = { uaEnabled: false, userAgent: 'x', proxyPort: 1, proxyEnabled: true };
    const merged = legacyProxyMerge(entry as never);
    assert.equal(merged.uaEnabled, false);
    assert.equal(merged.userAgent, 'x');
    assert.equal(merged.proxyPort, 1);
    assert.equal(merged.proxyEnabled, true, '原样保留 entry 的代理开关');
  } finally {
    delete process.env.DSH_HOME;
    if (originalHome !== undefined) process.env.DSH_HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Config schema 默认值 = 文档默认（序列化 schema 含 default 元数据）', () => {
  const serialized = JSON.stringify((Config as unknown as { toJSON(): unknown }).toJSON());
  for (const key of ['uaEnabled', 'proxyEnabled', 'proxyProtocol', 'proxyPort', 'proxyTimeoutMs', 'retryEnabled', 'maxRetries']) {
    assert.ok(serialized.includes(`"${key}"`), `schema 应声明字段 ${key}`);
  }
  assert.ok(serialized.includes('"default":7890'), 'proxyPort 默认值 7890');
  assert.ok(serialized.includes('"default":60000'), 'proxyTimeoutMs 默认值 60000');
  assert.ok(serialized.includes('"default":2'), 'maxRetries 默认值 2');
});