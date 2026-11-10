/** Sequential production boots in isolated profiles; never touches ~/.dsh. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, realpath, symlink, unlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.cache/runtime');
const aliases = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).dependencies;
const selected = process.argv.find(value => value.startsWith('--version='))?.slice(10);
const keep = process.argv.includes('--keep');
const verifyPiAi = process.argv.includes('--pi-ai');
const testIdleTimeout = 1500;
const testOverrideTimeout = 2200;
const results = [];
let httpModelRequests = 0;
let wsModelRequests = 0;
const modelSockets = new Set();
const echo = createServer((req, res) => {
  if (req.url === '/pi-ai-http/chat/completions') {
    httpModelRequests++;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keepalive\n\n');
    const timer = setInterval(() => res.write(': keepalive\n\n'), 60);
    res.once('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ua: req.headers['user-agent'] }));
});
echo.on('upgrade', (req, socket) => {
  if (req.url !== '/pi-ai-ws/codex/responses' || !req.headers['sec-websocket-key']) {
    socket.destroy();
    return;
  }
  wsModelRequests++;
  modelSockets.add(socket);
  socket.on('close', () => modelSockets.delete(socket));
  socket.on('error', () => socket.destroy());
  const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n');
  socket.resume();
});
await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
const echoURL = `http://127.0.0.1:${echo.address().port}`;
const fixture = join(root, `.cache/launch-fixture-${process.pid}`); await mkdir(fixture, { recursive: true });
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'network-launch-fixture', type: 'module', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
await writeFile(join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: network-launch-fixture\n      name: network-launch-fixture\n');
await writeFile(join(fixture, 'index.mjs'), `export const inject=['dshLoader', 'llm']; export function apply(ctx) {
const loader = ctx.dshLoader.services.get('loader');
const find = name => [...loader.entries()].find(entry => entry.options.name === name);
const reply = (res, body) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
ctx.effect(()=>ctx.dshLoader.web.get('/__network-test', async(_req,res)=>{
  try {
    const response = await fetch(${JSON.stringify(echoURL)});
    reply(res, await response.json());
  } catch (error) { reply(res, { error: String(error) }); }
}));
ctx.effect(() => ctx.dshLoader.web.get('/__pi-ai-config', (_req, res) => {
  const fiber = find('@deepseek-ai/dsh-llm-pi-ai')?.fiber;
  const settings = ctx.dshLoader.services.get('settings');
  const fromSettings = typeof settings?.installSection === 'function' && settings.get('llm-pi-ai');
  const ref = (fiber?.effectiveConfig ?? fiber?.config)?.providers;
  const providers = fromSettings?.providers ?? (typeof ref?.get === 'function' ? ref.get() : ref) ?? {};
  reply(res, Object.fromEntries(Object.entries(providers).map(([id, profile]) => [id, profile.streamIdleTimeoutMs])));
}));
for (const provider of ['fixture-http', 'openai-codex', 'fixture-override']) {
  ctx.effect(() => ctx.dshLoader.web.get('/__pi-ai-' + provider, async (_req, res) => {
    try {
      for await (const chunk of ctx.llm.stream({
        provider, model: provider === 'openai-codex' ? 'gpt-5.2-codex' : 'example-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'example' }] }],
      })) {
        if (chunk.type === 'finish' && chunk.reason?.failure) {
          reply(res, chunk.reason.failure);
          return;
        }
      }
      reply(res, { code: 'completed' });
    } catch (error) { reply(res, { code: error.code ?? error.failure?.code, message: error.message }); }
  }));
}
ctx.effect(() => ctx.dshLoader.web.post('/__pi-ai-unload', async (req, res) => {
  const connection = ctx.dshLoader.services.get('connection');
  if (!connection?.authorizeIndex(req, res)) return;
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
    res.writeHead(403).end();
    return;
  }
  await find('@dsh-plugin/dsh-network-settings').fiber.dispose();
  reply(res, { unloaded: true });
}));
}`);
async function link(target, path) {
  await mkdir(dirname(path), { recursive: true });
  const resolved = await realpath(target);
  if (existsSync(path) && await realpath(path) !== resolved) {
    assert((await lstat(path)).isSymbolicLink(), `Refusing to replace non-test link: ${path}`);
    await unlink(path);
  }
  if (!existsSync(path)) await symlink(resolved, path, process.platform === 'win32' ? 'junction' : 'dir');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(version, bin, home, logFile) {
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' };
  env.NETWORK_TEST_API_KEY = 'sk-network-fixture';
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'example' } })).toString('base64url');
  env.NETWORK_TEST_CODEX_KEY = `e30.${claims}.example`;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'DSHLOADER_DSH_VERSION']) delete env[key];
  const child = spawn(process.execPath, [bin, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, cwd: root, windowsHide: true });
  let output = '', url;
  child.stdout.on('data', chunk => { output += chunk; url ??= /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1]; });
  child.stderr.on('data', chunk => { output += chunk; });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      for (let i=0;i<30 && child.exitCode===null && child.signalCode===null;i++) await delay(100);
    }
    await writeFile(logFile, output.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'));
  };
  for (let i=0;i<300 && !url && child.exitCode===null;i++) await delay(100);
  if (!url) { await stop(); throw new Error(`Boot failed (${child.exitCode}): ${output.slice(-2200)}`); }
  return { child, url, stop };
}
try {
  for (const [alias, spec] of Object.entries(aliases)) {
    const version = spec.split('@').at(-1);
    if (selected && version !== selected) continue;
    const startedAt = Date.now();
    const home = join(root, keep ? '.cache/browser-launch' : '.cache/launch', verifyPiAi ? `${version}-pi-ai-${process.pid}` : version);
    const profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    const pkg = { name: 'network-test-web', private: true, dependencies: { '@dsh-plugin/dsh-loader': `file:${resolve(root, '../dsh-loader')}`, '@dsh-plugin/dsh-network-settings': `file:${root}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-plugin/dsh-loader', '@dsh-plugin/dsh-network-settings', 'network-launch-fixture'], patchReload: 'startup' } } };
    await writeFile(join(profile, 'package.json'), JSON.stringify(pkg, null, 2));
    const patchPath = join(profile, 'cordis.patch.yml');
    const legacy = version === '0.1.5-rc.3';
    const provider = { api: 'openai-completions', apiKeyEnv: 'NETWORK_TEST_API_KEY', baseURL: echoURL + '/pi-ai-http', models: [{ id: 'example-model' }] };
    const providers = {
      'fixture-http': provider,
      'openai-codex': { apiKeyEnv: 'NETWORK_TEST_CODEX_KEY', baseURL: echoURL + '/pi-ai-ws', transport: 'websocket', models: [{ id: 'gpt-5.2-codex' }] },
      'fixture-override': { ...provider, streamIdleTimeoutMs: testOverrideTimeout },
    };
    const patch = verifyPiAi && !legacy ? [{ id: 'llm-pi-ai', config: { providers } }] : [];
    const patchText = JSON.stringify(patch, null, 2) + '\n';
    await writeFile(patchPath, patchText);
    const settingsPath = join(home, 'settings.yaml');
    const settingsText = JSON.stringify({ 'llm-pi-ai': { providers } }, null, 2) + '\n';
    if (legacy) {
      await writeFile(settingsPath, verifyPiAi ? settingsText : '{}\n');
    }
    const separate = join(root, '.cache/versions', version, 'node_modules/@deepseek-ai/dsh');
    const installation = await realpath(existsSync(separate) ? separate : join(runtime, 'node_modules', alias));
    await link(installation, join(profile, 'node_modules/@deepseek-ai/dsh'));
    await link(resolve(root, '../dsh-loader'), join(profile, 'node_modules/@dsh-plugin/dsh-loader'));
    await link(root, join(profile, 'node_modules/@dsh-plugin/dsh-network-settings'));
    await link(fixture, join(profile, 'node_modules/network-launch-fixture'));
    let server;
    try {
      server = await start(version, join(installation, 'lib/bin.js'), home, join(home, 'host.log'));
      const origin = new URL(server.url).origin;
      let login;
      for (let i=0;i<50;i++) { try { login = await fetch(server.url, { redirect: 'manual' }); break; } catch (error) { if (i===49) throw error; await delay(100); } }
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const request = async (path, body) => {
        const response = await fetch(origin + path, { headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
        const text = await response.text();
        try { return { status: response.status, body: JSON.parse(text) }; }
        catch { throw new Error(`${path} returned ${response.status}: ${text}`); }
      };
      let list;
      for (let i=0;i<150;i++) {
        try { list = await request('/api/dshloader/config'); if (list.status===200 && list.body.value.some(view=>view.template.id==='dsh-network-settings')) break; } catch {}
        if (server.child.exitCode !== null) throw new Error('Host exited during plugin activation');
        await delay(100);
      }
      assert.equal(list?.status, 200, 'Configuration bridge must activate');
      const view = list.body.value.find(view => view.template.id === 'dsh-network-settings'); assert(view);
      const expectIdle = async expected => {
        for (let i = 0; i < 80; i++) {
          const state = (await request('/__pi-ai-config')).body;
          if (state['fixture-http'] === expected && state['openai-codex'] === expected) {
            assert.equal(state['fixture-override'], testOverrideTimeout);
            return;
          }
          await delay(50);
        }
        assert.fail(`pi-ai 超时未更新为 ${expected}: ${JSON.stringify((await request('/__pi-ai-config')).body)}`);
      };
      if (verifyPiAi) {
        await expectIdle(240000);
      }
      const value = { uaEnabled: true, userAgent: `network-matrix/${version}`, proxyEnabled: false, retryEnabled: false, proxyPassword: 'matrix-secret' };
      if (verifyPiAi) {
        value.requestIdleTimeoutMs = testIdleTimeout;
      }
      const saved = await request('/api/dshloader/config/dsh-network-settings', { expectedRevision: view.revision, value });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert(!JSON.stringify(saved.body).includes('matrix-secret'));
      const echo = await request('/__network-test'); assert.equal(echo.body.ua, `network-matrix/${version}`);
      const conflict = await request('/api/dshloader/config/dsh-network-settings', { expectedRevision: view.revision, value: { userAgent: 'stale' } }); assert.equal(conflict.status, 409);
      const disk = JSON.parse(await readFile(join(profile, 'config/dsh-network-settings/config.json'), 'utf8')); assert.equal(disk.value.userAgent, `network-matrix/${version}`);
      const html = await (await fetch(origin, { headers: { cookie } })).text();
      assert(html.includes('__DSHLOADER_BOOT__') && html.includes(version), 'Host must inject versioned browser boot');
      assert.equal((await request('/_dsh/dsh-network-settings/probe')).status, 200);
      if (verifyPiAi) {
        await expectIdle(testIdleTimeout);
        for (const [provider, timeout] of [
          ['fixture-http', testIdleTimeout],
          ['openai-codex', testIdleTimeout],
          ['fixture-override', testOverrideTimeout],
        ]) {
          const count = () => provider === 'openai-codex' ? wsModelRequests : httpModelRequests;
          const before = count();
          const result = (await request('/__pi-ai-' + provider)).body;
          assert.equal(result.code, 'TIMEOUT', `${provider}: ${JSON.stringify(result)}`);
          assert.match(result.message, new RegExp(`idle timeout after ${timeout}ms`));
          assert.equal(count() - before, 1, `${provider} 应连接本地模拟上游`);
        }
        assert.equal(await readFile(patchPath, 'utf8'), patchText);
        if (legacy) {
          assert.equal(await readFile(settingsPath, 'utf8'), settingsText);
        }
        assert.equal((await request('/__pi-ai-unload', {})).body.unloaded, true);
        await expectIdle(300000);
        console.log(`PASS ${version}: pi-ai 默认值、HTTP 与 WebSocket 空闲超时、显式覆盖及卸载恢复`);
      }
      results.push({ version, ok: true, durationMs: Date.now()-startedAt, revision: disk.revision });
      console.log(`PASS ${version}: real boot, authenticated config, disk, UA, secrets, conflict, browser boot`);
      if (keep) {
        await writeFile(join(root, '.cache/launch/active.json'), JSON.stringify({ version, url: server.url, profile }, null, 2));
        console.log(`BROWSER_READY ${version} (URL in .cache/launch/active.json); press Enter to stop`);
        await new Promise(resolve => process.stdin.once('data', resolve));
        process.stdin.pause();
      }
    } catch (error) { const detail = String(error) + (error.cause ? ' / ' + String(error.cause) : ''); results.push({ version, ok: false, error: detail }); console.log(`FAIL ${version}: ${detail.slice(0,1200)}`); }
    finally { await server?.stop(); await writeFile(join(root, '.cache/launch', selected ? `results-${selected}.json` : 'results.json'), JSON.stringify(results, null, 2)); }
  }
} finally {
  for (const socket of modelSockets) {
    socket.destroy();
  }
  echo.close();
}
if (results.some(result => !result.ok)) process.exitCode = 1;
