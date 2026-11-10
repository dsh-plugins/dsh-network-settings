import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { installPiAiTimeout } from '../lib/pi-ai-timeout.js';

test('保存和卸载时等待正在重载的 pi-ai，再应用空闲超时', async () => {
  const raw = { providers: { example: {} } };
  let timeout = 240000;
  let hook: ((raw: unknown, next: () => unknown) => unknown) | undefined;
  let save: ((snapshot: { value: { requestIdleTimeoutMs: number } }) => void) | undefined;
  let dispose: (() => Promise<void>) | undefined;
  let settled = Promise.resolve();
  const effective: number[] = [];
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai' } };
  const fiber = {
    entry,
    state: 2,
    await: () => settled,
    async restart() {
      const result = hook?.call(this, raw, () => raw) as { providers?: { example?: { streamIdleTimeoutMs?: number } } } | undefined;
      effective.push(result?.providers?.example?.streamIdleTimeoutMs ?? 300000);
    },
  };
  const target = Object.assign(entry, { fiber });
  const startReload = () => {
    const barrier = Promise.withResolvers<void>();
    settled = barrier.promise;
    fiber.state = 1;
    return () => {
      fiber.state = 2;
      barrier.resolve();
    };
  };
  installPiAiTimeout({
    dshLoader: { services: { get: (key: string) => key === 'loader' ? { entries: () => [target] } : undefined } },
    effect: (start: () => (() => Promise<void>)) => { dispose = start(); },
    on: (_event: string, callback: typeof hook) => {
      hook = callback;
      return () => { hook = undefined; };
    },
  } as Parameters<typeof installPiAiTimeout>[0], {
    get: () => ({ value: { requestIdleTimeoutMs: timeout } }),
    watch: (callback: typeof save) => {
      save = callback;
      return () => { save = undefined; };
    },
  } as Parameters<typeof installPiAiTimeout>[1]);
  await setImmediate();
  assert.deepEqual(effective, [240000]);

  const saved = startReload();
  timeout = 90000;
  save?.({ value: { requestIdleTimeoutMs: timeout } });
  await setImmediate();
  assert.deepEqual(effective, [240000]);
  saved();
  await setImmediate();
  assert.deepEqual(effective, [240000, 90000]);

  const unloading = startReload();
  const release = dispose?.();
  await setImmediate();
  assert.deepEqual(effective, [240000, 90000]);
  unloading();
  await release;
  assert.deepEqual(effective, [240000, 90000, 300000]);
});
