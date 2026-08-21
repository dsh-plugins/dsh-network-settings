/**
 * UA 改写纯逻辑测试（node --test，TypeScript 源）。
 *
 * 直接针对 lib 产物中的纯函数：头部构造、策略判定、端到端 wrapper 检查
 * （本地 HTTP echo server 验证改写链路）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { applyUserAgent, shouldRewriteUA, fetchWithRetry } from '../lib/index.js';

const UA = 'MyTestUA/2.0 (+https://example.test)';

test('applyUserAgent 强制 user-agent 并保留其它头/body/method', () => {
  const body = JSON.stringify({ hello: 'world' });
  const init = {
    method: 'POST',
    body,
    headers: { 'user-agent': 'original-agent', 'x-custom': 'yes' },
  };
  const next = applyUserAgent(init, UA);
  assert.notEqual(next, init, '必须返回新 init，不得修改调用方');
  assert.equal((init.headers as Record<string, string>).ua, undefined, '调用方对象不得被修改');
  assert.equal(next.method, 'POST');
  assert.equal(next.body, body);
  const headers = new Headers(next.headers);
  assert.equal(headers.get('user-agent'), UA);
  assert.equal(headers.get('x-custom'), 'yes');
});

test('applyUserAgent 无 init 时产出仅含 headers 的 init', () => {
  const next = applyUserAgent(undefined, UA);
  assert.equal(new Headers(next.headers).get('user-agent'), UA);
  assert.equal(next.method, undefined);
});

test('applyUserAgent 接受 Headers 实例', () => {
  const headers = new Headers({ 'x-test': '1' });
  const next = applyUserAgent({ headers }, UA);
  const out = new Headers(next.headers);
  assert.equal(out.get('user-agent'), UA);
  assert.equal(out.get('x-test'), '1');
});

test('shouldRewriteUA 以 uaEnabled + 非空 UA 为门槛', () => {
  assert.equal(shouldRewriteUA(undefined), false);
  assert.equal(shouldRewriteUA({ uaEnabled: false, userAgent: UA }), false);
  assert.equal(shouldRewriteUA({ uaEnabled: true, userAgent: '  ' }), false);
  assert.equal(shouldRewriteUA({ uaEnabled: true, userAgent: UA }), true);
  assert.equal(shouldRewriteUA({ uaEnabled: true, userAgent: ` ${UA} ` }), true);
});

test('fetch 链路：rewrite + 重试叠放后 UA 仍在线上、重试计数正确', async () => {
  let hits = 0;
  const seenUserAgent: string[] = [];
  const seenCustom: string[] = [];
  const server = createServer((req, res) => {
    hits += 1;
    seenUserAgent.push(req.headers['user-agent'] ?? '');
    seenCustom.push(req.headers['x-custom'] ?? '');
    res.writeHead(hits < 2 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(hits < 2 ? '{}' : '{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/echo`;

  try {
    const original = globalThis.fetch;
    // 模拟 index.ts 的 inner（UA 改写）作为 retry 的 delegate
    const inner = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const next = applyUserAgent(init, UA);
      return original(url, next);
    };
    const retries: Array<{ status?: number; error?: unknown }> = [];
    const res = await fetchWithRetry(
      url,
      { headers: { 'x-custom': 'hello', 'user-agent': 'ignored' } },
      inner,
      { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5, onRetry: (_, info) => retries.push({ status: info.status, error: info.error }) },
    );
    assert.equal(res.status, 200);
    assert.equal(hits, 2, '503 后应重试恰好一次并成功');
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.status, 503);
    assert.equal(seenUserAgent[0], UA, '重试发起的第一跳也要带改写后的 UA');
    assert.equal(seenUserAgent[1], UA);
    assert.equal(seenCustom[0], 'hello');
  } finally {
    server.close();
  }
});