import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createSecureServer, type Http2SecureServer } from 'node:http2';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { MockAgent } from 'undici';
import { createPatchAPI } from '@dsh-plugin/dsh-loader/patch';
import { validateValues, type ConfigSnapshot, type ConfigTemplate } from '@dsh-plugin/dsh-loader/config';
import { apply, Config, proxiedFetch, type PluginConfig } from '../lib/index.js';

async function listen(t: TestContext, server: Server | ReturnType<typeof createTcpServer> | Http2SecureServer): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    for (const socket of sockets) {
      socket.destroy();
    }
  }));
  return (server.address() as { port: number }).port;
}

test('全局 fetch 保留 Request 鉴权，代理重定向重新匹配直连规则', { timeout: 10000 }, async t => {
  const original = globalThis.fetch;
  const cleanups: (() => void)[] = [];
  let state = { value: Config({ userAgent: 'network-test', retryEnabled: false }), revision: 0 };
  const listeners = new Set<() => void>();
  const configure = (patch: Partial<PluginConfig>) => {
    state = { value: { ...state.value, ...patch }, revision: state.revision + 1 };
    for (const listener of listeners) {
      listener();
    }
  };
  await apply({
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') {
        cleanups.push(off);
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    dshLoader: {
      patch: createPatchAPI(),
      services: { get: () => undefined },
      config: {
        async register(_owner: unknown, template: ConfigTemplate) {
          const get = () => ({
            value: validateValues(template.fields, state.value),
            revision: template.id === 'dsh-network-settings' ? 0 : state.revision,
          });
          return {
            get,
            watch: (listener: (snapshot: ConfigSnapshot) => void) => {
              const notify = () => listener(get());
              listeners.add(notify);
              return () => listeners.delete(notify);
            },
            dispose() {},
          };
        },
      },
    },
  } as Parameters<typeof apply>[0], state.value);
  t.after(() => {
    for (const off of cleanups.reverse()) {
      off();
    }
    globalThis.fetch = original;
  });

  let redirectedAuth: string | undefined;
  const targetPort = await listen(t, createServer(async (req, res) => {
    if (req.url === '/redirected') {
      redirectedAuth = req.headers.authorization;
      res.end('direct');
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    res.statusCode = req.headers.authorization === 'Bearer example' ? 200 : 401;
    res.end(JSON.stringify({ method: req.method, body, ua: req.headers['user-agent'] }));
  }));
  const target = `http://127.0.0.1:${targetPort}`;
  const request = () => new Request(target, {
    method: 'POST',
    headers: { authorization: 'Bearer example' },
    body: 'payload',
  });
  const direct = await fetch(request());
  assert.equal(direct.status, 200);
  assert.deepEqual(await direct.json(), { method: 'POST', body: 'payload', ua: 'network-test' });
  const override = await fetch(request(), { headers: { 'x-test': 'example' } });
  assert.equal(override.status, 401);
  await override.body?.cancel();

  const proxyPaths: string[] = [];
  const proxyPort = await listen(t, createServer(async (req, res) => {
    proxyPaths.push(req.url!);
    if (req.url?.endsWith('/redirect')) {
      res.writeHead(302, { location: target + '/redirected' }).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    res.statusCode = req.headers.authorization === 'Bearer example' ? 200 : 401;
    res.end(JSON.stringify({ method: req.method, body, ua: req.headers['user-agent'] }));
  }));
  configure({ proxyEnabled: true, proxyHost: '127.0.0.1', proxyPort, proxyNoProxy: [] });
  const proxied = await fetch(request());
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { method: 'POST', body: 'payload', ua: 'network-test' });
  assert.deepEqual(proxyPaths, [target + '/']);

  const remote = 'http://example.invalid/redirect';
  configure({ proxyNoProxy: [`127.0.0.1:${targetPort}`] });
  const redirected = await fetch(remote, { headers: { authorization: 'Bearer example' } });
  assert.equal(await redirected.text(), 'direct');
  assert.equal(redirectedAuth, undefined);
  assert.deepEqual(proxyPaths, [target + '/', remote]);
  assert.equal(await (await fetch(new Request(remote))).text(), 'direct');
  const manual = await fetch(remote, { redirect: 'manual' });
  assert.equal(manual.status, 302);
  await manual.body?.cancel();

  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  dispatcher.get('http://example.invalid').intercept({ path: '/caller' }).reply(200, 'caller dispatcher');
  dispatcher.get('http://example.invalid').intercept({ path: '/request' }).reply(200, 'request dispatcher');
  const callerInit = { dispatcher };
  assert.equal(await (await fetch('http://example.invalid/caller', callerInit)).text(), 'caller dispatcher');
  assert.equal(await (await fetch(new Request('http://example.invalid/request', callerInit))).text(), 'request dispatcher');
});

test('代理和直连分别限制首包和流式空闲时间，持续输出不受总时长限制', { timeout: 20000 }, async t => {
  const firstAttempts = new Map<string, number>();
  const streamAttempts = new Map<string, number>();
  const port = await listen(t, createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://example.invalid').pathname;
    if (path.startsWith('/first')) {
      const count = (firstAttempts.get(path) ?? 0) + 1;
      firstAttempts.set(path, count);
      if (count === 2) {
        res.end('retried');
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('start');
    if (path.startsWith('/stall')) {
      streamAttempts.set(path, (streamAttempts.get(path) ?? 0) + 1);
      return;
    }
    let remaining = 16;
    const interval = setInterval(() => {
      res.write('.');
      if (--remaining === 0) {
        clearInterval(interval);
        res.end('end');
      }
    }, 100);
    res.on('close', () => clearInterval(interval));
  }));

  const original = globalThis.fetch;
  const cleanups: (() => void)[] = [];
  let proxyEnabled = false;
  const config = () => Config({
    retryEnabled: true, maxRetries: 1, requestIdleTimeoutMs: 240, proxyEnabled,
    proxyPort: port, proxyNoProxy: [],
  });
  await apply({
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') {
        cleanups.push(off);
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    dshLoader: {
      patch: createPatchAPI(),
      services: { get: () => undefined },
      config: {
        async register(_owner: unknown, template: ConfigTemplate) {
          return {
            get: () => ({
              value: validateValues(template.fields, config()),
              revision: template.id === 'dsh-network-settings' ? 0 : Number(proxyEnabled),
            }),
            watch: () => () => {},
            dispose() {},
          };
        },
      },
    },
  } as Parameters<typeof apply>[0], config());
  t.after(() => {
    for (const off of cleanups.reverse()) {
      off();
    }
    globalThis.fetch = original;
  });

  for (const mode of ['direct', 'proxy']) {
    proxyEnabled = mode === 'proxy';
    const base = proxyEnabled ? 'http://example.invalid' : `http://127.0.0.1:${port}`;
    assert.equal(await (await fetch(base + '/first-' + mode)).text(), 'retried');
    assert.equal(firstAttempts.get('/first-' + mode), 2);
    const stalled = await fetch(base + '/stall-' + mode);
    await assert.rejects(stalled.text(), (error: Error & { cause?: { code?: string } }) => error.cause?.code === 'UND_ERR_BODY_TIMEOUT');
    assert.equal(streamAttempts.get('/stall-' + mode), 1);
    assert.equal(await (await fetch(base + '/active')).text(), 'start' + '.'.repeat(16) + 'end');
  }
});

test('SOCKS5 对 HTTP 目标先协商隧道，完整读取可变长度握手响应', { timeout: 8000 }, async t => {
  const targetPort = await listen(t, createServer((req, res) => res.end(req.headers.authorization)));
  let target = '';
  const proxyPort = await listen(t, createTcpServer(socket => {
    socket.once('data', greeting => {
      assert.deepEqual(greeting, Buffer.from([5, 1, 0]));
      socket.write(Buffer.from([5, 0]));
      socket.once('data', request => {
        assert.equal(request[3], 3);
        const length = request[4];
        target = request.subarray(5, 5 + length).toString();
        const upstream = connect({ host: '127.0.0.1', port: request.readUInt16BE(5 + length) });
        upstream.once('connect', () => {
          socket.write(Buffer.from([5, 0, 0, 3, 3, 102, 111, 111, 0, 0]));
          socket.pipe(upstream).pipe(socket);
        });
        socket.once('close', () => upstream.destroy());
        upstream.once('error', error => socket.destroy(error));
      });
    });
  }));
  const response = await proxiedFetch(
    new Request(`http://example.invalid:${targetPort}/`, { headers: { authorization: 'Bearer example' } }),
    {},
    { protocol: 'socks5', host: '127.0.0.1', port: proxyPort, noProxy: [], timeout: 1000, connectTimeout: 1000 },
    fetch,
  );
  assert.equal(await response.text(), 'Bearer example');
  assert.equal(target, 'example.invalid');
});

test('取消 SOCKS5 请求时释放尚未建立的隧道', { timeout: 5000 }, async t => {
  const server = createTcpServer();
  const port = await listen(t, server);
  const connected = once(server, 'connection');
  const controller = new AbortController();
  const request = proxiedFetch('http://example.invalid', { signal: controller.signal }, {
    protocol: 'socks5', host: '127.0.0.1', port, connectTimeout: 60000,
  }, fetch);
  const [socket] = await connected as [Socket];
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
  socket.resume();
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await closed;
});

test('HTTPS CONNECT 保留 HTTP/2、鉴权与空闲超时', { timeout: 10000 }, async t => {
  const candidates = ['openssl'];
  if (process.platform === 'win32' && process.env.ProgramFiles) {
    candidates.push(join(process.env.ProgramFiles, 'Git/usr/bin/openssl.exe'));
  }
  const openssl = candidates.find(command => spawnSync(command, ['version']).status === 0);
  if (!openssl) {
    t.skip('需要 OpenSSL 生成临时 TLS 证书');
    return;
  }
  const folder = await mkdtemp(join(tmpdir(), 'network-connect-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const keyPath = join(folder, 'key.pem');
  const certPath = join(folder, 'cert.pem');
  execFileSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  const key = await readFile(keyPath);
  const cert = await readFile(certPath, 'utf8');
  const originalCAs = getCACertificates('default');
  setDefaultCACertificates([...originalCAs, cert]);
  t.after(() => setDefaultCACertificates(originalCAs));

  const upstream = createSecureServer({ key, cert });
  upstream.on('stream', (stream, headers) => {
    assert.equal(headers['proxy-authorization'], undefined);
    if (headers[':path'] === '/headers') {
      return;
    }
    stream.respond({ ':status': 200 });
    if (headers[':path'] === '/body') {
      stream.write('start');
    } else {
      stream.end(String(headers.authorization));
    }
  });
  const upstreamPort = await listen(t, upstream);
  const proxy = createServer();
  const authorization: unknown[] = [];
  proxy.on('connect', (req, socket, head) => {
    authorization.push(req.headers['proxy-authorization']);
    const target = connect({ port: upstreamPort, host: '127.0.0.1' });
    target.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      target.write(head);
      socket.pipe(target).pipe(socket);
    });
    socket.once('close', () => target.destroy());
    target.once('error', () => socket.destroy());
  });
  const port = await listen(t, proxy);
  const cfg: NetProxy = { protocol: 'http', host: '127.0.0.1', port, username: 'example', password: 'example', timeout: 250 };
  const url = `https://127.0.0.1:${upstreamPort}`;
  const result = await proxiedFetch(url, { headers: { authorization: 'Bearer example' } }, cfg, fetch);
  assert.equal(await result.text(), 'Bearer example');
  await assert.rejects(proxiedFetch(url + '/headers', {}, cfg, fetch), (error: Error & { cause?: { code?: string } }) => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT');
  const stalled = await proxiedFetch(url + '/body', {}, cfg, fetch);
  await assert.rejects(stalled.text(), (error: Error & { cause?: { code?: string } }) => error.cause?.code === 'UND_ERR_BODY_TIMEOUT');
  assert.deepEqual(authorization, Array(3).fill('Basic ' + Buffer.from('example:example').toString('base64')));
});
