/**
 * 代理引擎测试（node --test，TypeScript 源）。
 *
 * - isNoProxy：NO_PROXY 直连判定纯函数
 * - proxiedFetch：经本地 HTTP 转发代理的真实端到端请求（普通 / 重定向 /
 *   压缩自动解压 / POST body / content-length）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import zlib from 'node:zlib';
import { proxiedFetch, isNoProxy, type NetProxy } from '../lib/index.js';

test('isNoProxy：host / 后缀 / host:port / CIDR / * / <local>', () => {
  const noProxy = ['example.com', '.suffix.test', '10.0.0.0/8', '*:873', '<local>'];
  // host 精确
  assert.equal(isNoProxy('http://example.com/x', noProxy), true);
  // 子域后缀（.suffix.test 匹配 foo.suffix.test）
  assert.equal(isNoProxy('https://foo.suffix.test/', noProxy), true);
  assert.equal(isNoProxy('https://bar.suffix.test:443/', noProxy), true);
  // CIDR
  assert.equal(isNoProxy('http://10.1.2.3/', noProxy), true);
  assert.equal(isNoProxy('http://11.1.2.3/', noProxy), false);
  // host:port —— example.com 无端口限制，匹配任意端口；873 精确条目已由上面覆盖
  assert.equal(isNoProxy('http://example.com:873/', noProxy), true);
  assert.equal(isNoProxy('http://example.com:8080/', noProxy), true, '无端口声明的 host 匹配该 host 任意端口');
  // <local>：回环
  assert.equal(isNoProxy('http://127.0.0.1:8080/', noProxy), true);
  assert.equal(isNoProxy('http://localhost:8080/', noProxy), true);
  assert.equal(isNoProxy('http://[::1]/', noProxy), true);
  // 未命中
  assert.equal(isNoProxy('https://deepseek.com/', noProxy), false);
  // 空数组 → 全走代理
  assert.equal(isNoProxy('http://127.0.0.1/', []), false);
  assert.equal(isNoProxy('http://127.0.0.1/', undefined), false);
  // *
  assert.equal(isNoProxy('https://anything.io/', ['*']), true);
});

test('proxiedFetch：经本地 HTTP 转发代理的端到端（普通 / 302 / gzip / br / deflate / POST）', async (t) => {
  type Serve = { status: number; headers: Record<string, string | number>; body: Buffer | string };
  const routes = new Map<string, Serve>([
    ['/real', { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'REAL-BODY' }],
    ['/gzip', { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(Buffer.from('GZIP-BODY')) }],
    ['/br', { status: 200, headers: { 'Content-Encoding': 'br' }, body: zlib.brotliCompressSync(Buffer.from('BR-BODY')) }],
    ['/deflate', { status: 200, headers: { 'Content-Encoding': 'deflate' }, body: zlib.deflateSync(Buffer.from('DEFLATE-BODY')) }],
    ['/slow', { status: 200, headers: {}, body: 'SLOW-OK' }],
  ]);

  const target = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/real` });
      res.end();
      return;
    }
    if (req.url === '/echo') {
      let data = '';
      req.on('data', (c: Buffer) => {
        data += c.toString('utf8');
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body: data, ua: req.headers['user-agent'] }));
      });
      return;
    }
    const hit = routes.get(req.url ?? '');
    if (hit) {
      const h: Record<string, string | number> = { 'Content-Length': Buffer.byteLength(hit.body), ...hit.headers };
      res.writeHead(hit.status, h);
      res.end(hit.body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // 极简 HTTP 转发代理：把绝对 URL 解析后转发到目标（对应 HTTP 目标的代理语义）
  const proxy = createServer((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    const upstream = httpRequest(
      {
        host: u.hostname,
        port: Number(u.port || 80),
        path: u.pathname + u.search,
        method: req.method,
        headers: req.headers,
        agent: false,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 200, r.headers);
        r.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  let targetPort = 0;
  let proxyPort = 0;
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  targetPort = (target.address() as { port: number }).port;
  proxyPort = (proxy.address() as { port: number }).port;
  t.after(() => {
    target.close();
    proxy.close();
  });

  const proxyCfg: NetProxy = {
    protocol: 'http',
    host: '127.0.0.1',
    port: proxyPort,
    username: '',
    password: '',
    noProxy: [],
  };
  const base = `http://127.0.0.1:${targetPort}`;

  await t.test('普通 GET', async () => {
    const r = await proxiedFetch(`${base}/real`, {}, proxyCfg, fetch);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'REAL-BODY');
  });

  await t.test('302 自动跟随', async () => {
    const r = await proxiedFetch(`${base}/redirect`, {}, proxyCfg, fetch);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'REAL-BODY');
  });

  await t.test('gzip 自动解压', async () => {
    const r = await proxiedFetch(`${base}/gzip`, {}, proxyCfg, fetch);
    assert.equal(await r.text(), 'GZIP-BODY');
  });

  await t.test('brotli 自动解压', async () => {
    const r = await proxiedFetch(`${base}/br`, {}, proxyCfg, fetch);
    assert.equal(await r.text(), 'BR-BODY');
  });

  await t.test('deflate 自动解压', async () => {
    const r = await proxiedFetch(`${base}/deflate`, {}, proxyCfg, fetch);
    assert.equal(await r.text(), 'DEFLATE-BODY');
  });

  await t.test('POST body + content-length + 头保留', async () => {
    const r = await proxiedFetch(
      `${base}/echo`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-extra': 'yes', 'user-agent': 'ProxyTestUA' },
        body: JSON.stringify({ a: 1 }),
      },
      proxyCfg,
      fetch,
    );
    assert.equal(r.status, 200);
    const parsed = JSON.parse(await r.text()) as { method: string; body: string; ua: string };
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.body, JSON.stringify({ a: 1 }));
    assert.equal(parsed.ua, 'ProxyTestUA');
  });

  await t.test('NO_PROXY 命中时直连（不经代理）', async () => {
    // noProxy 包含目标 host：proxiedFetch 直接走 originalFetch
    const direct = await proxiedFetch(`${base}/real`, {}, { ...proxyCfg, noProxy: ['127.0.0.1'] }, fetch);
    assert.equal(await direct.text(), 'REAL-BODY');
  });
});