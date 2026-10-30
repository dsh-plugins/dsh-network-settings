/** Sequential production boots in isolated profiles; never touches ~/.dsh. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const results = [];
const echo = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ua: req.headers['user-agent'] })); });
await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
const echoURL = `http://127.0.0.1:${echo.address().port}`;
const fixture = join(root, `.cache/launch-fixture-${process.pid}`); await mkdir(fixture, { recursive: true });
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'network-launch-fixture', type: 'module', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
await writeFile(join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: network-launch-fixture\n      name: network-launch-fixture\n');
await writeFile(join(fixture, 'index.mjs'), `export const inject=['dshLoader']; export function apply(ctx) {
ctx.effect(()=>ctx.dshLoader.web.get('/__network-test', async(_req,res)=>{
try { const response=await fetch(${JSON.stringify(echoURL)});res.writeHead(200,{'content-type':'application/json'});res.end(await response.text()); }
catch(error){res.writeHead(500);res.end(String(error));}
})); }`);
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
    const home = join(root, keep ? '.cache/browser-launch' : '.cache/launch', version), profile = join(home, 'profiles/web');
    await mkdir(profile, { recursive: true });
    const pkg = { name: 'network-test-web', private: true, dependencies: { '@dsh-plugin/dsh-loader': `file:${resolve(root, '../dsh-loader')}`, '@dsh-plugin/dsh-network-settings': `file:${root}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-plugin/dsh-loader', '@dsh-plugin/dsh-network-settings', 'network-launch-fixture'], patchReload: 'startup' } } };
    await writeFile(join(profile, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
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
      const saved = await request('/api/dshloader/config/dsh-network-settings', { expectedRevision: view.revision, value: { uaEnabled: true, userAgent: `network-matrix/${version}`, proxyEnabled: false, retryEnabled: false, proxyPassword: 'matrix-secret' } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert(!JSON.stringify(saved.body).includes('matrix-secret'));
      const echo = await request('/__network-test'); assert.equal(echo.body.ua, `network-matrix/${version}`);
      const conflict = await request('/api/dshloader/config/dsh-network-settings', { expectedRevision: view.revision, value: { userAgent: 'stale' } }); assert.equal(conflict.status, 409);
      const disk = JSON.parse(await readFile(join(profile, 'config/dsh-network-settings/config.json'), 'utf8')); assert.equal(disk.value.userAgent, `network-matrix/${version}`);
      const html = await (await fetch(origin, { headers: { cookie } })).text();
      assert(html.includes('__DSHLOADER_BOOT__') && html.includes(version), 'Host must inject versioned browser boot');
      assert.equal((await request('/_dsh/dsh-network-settings/probe')).status, 200);
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
} finally { echo.close(); }
if (results.some(result => !result.ok)) process.exitCode = 1;
