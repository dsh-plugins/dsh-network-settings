import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specs = JSON.parse(await readFile(new URL('../../dsh-loader/tests/fixtures/upstream/package.json', import.meta.url), 'utf8')).dependencies;
const runtime = join(root, '.cache/runtime'); await mkdir(runtime, { recursive: true });
await writeFile(join(runtime, 'package.json'), JSON.stringify({ private: true, dependencies: specs }, null, 2));
const pnpm = process.env.PNPM_CLI ?? join(process.env.APPDATA ?? '', 'npm/node_modules/pnpm/bin/pnpm.cjs');
const queue = Object.values(specs).map(spec => spec.split('@').at(-1));
const alpha1Pin = process.argv.includes('--alpha1-app-boot-pin');
async function worker() {
  while (queue.length) {
    const version = queue.shift(), dir = join(root, '.cache/versions', version);
    const override = alpha1Pin && version === '0.1.6-alpha.1'
      ? '\noverrides:\n  "@deepseek-ai/dsh@0.1.6-alpha.1>@deepseek-ai/dsh-app-boot": "0.1.6-alpha.1"\n' : '';
    if (existsSync(join(dir, '.installed')) && (!override || (await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).includes('overrides:'))) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': version } }));
    await writeFile(join(dir, 'pnpm-workspace.yaml'), `packages:\n  - .\nautoInstallPeers: true\nstrictPeerDependencies: false\nminimumReleaseAge: 0\nallowBuilds:\n${['@deepseek-ai/dsh-subprocess-local','node-pty','koffi','fs-ext','@google/genai','protobufjs'].map(name => `  '${name}': true`).join('\n')}\n${override}`);
    const log = createWriteStream(join(dir, 'install.log'));
    const env = { ...process.env, NO_PROXY: '*' }; for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']) delete env[key];
    const child = spawn(process.execPath, [pnpm, 'install', '--dir', dir, '--store-dir', resolve(root, '../.pnpm-store'), '--registry=https://registry.npmjs.org'], { env, windowsHide: true });
    child.stdout.pipe(log); child.stderr.pipe(log);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw new Error(`${version} installation failed; see ${join(dir,'install.log')}`);
    await writeFile(join(dir, '.installed'), version);
    console.log(`READY ${version}`);
  }
}
await Promise.all([worker(), worker()]);
