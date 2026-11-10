import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installStreamRetry } from '../lib/stream-retry.js';

test('Anthropic 上游断流按模型步骤退避重试，并遵循宿主决策、重试上限和取消信号', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let maxRetries = 1;
  let dispose: (() => void) | undefined;
  const listeners = new Map();
  installStreamRetry({
    get: () => undefined,
    reflect: { provide() {} },
    effect(activate) {
      const cleanup = activate();
      if (typeof cleanup === 'function') {
        dispose = cleanup;
      }
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
  }, () => maxRetries);
  t.after(() => dispose?.());

  const handler = listeners.get('agent/request-error');
  assert.equal(typeof handler, 'function');
  const controller = new AbortController();
  const failure = {
    code: 'PI_AI_ERROR',
    message: '{"error":{"message":"upstream stream disconnected: unexpected EOF","type":"stream_read_error"},"type":"error"}',
  };
  const request = { turn: 1, step: 1, signal: controller.signal, failure };
  const next = async () => undefined;
  const retry = async (step: number) => {
    const pending = handler({ ...request, step }, next);
    await Promise.resolve();
    t.mock.timers.runAll();
    return pending;
  };

  const hostAction = { kind: 'retry' };
  assert.equal(await handler(request, async () => hostAction), hostAction);
  assert.equal(await handler({ ...request, failure: { ...failure, message: '{' } }, next), undefined);
  assert.equal(await handler({
    ...request,
    failure: { ...failure, message: failure.message.replace('stream_read_error', 'overloaded_error') },
  }, next), undefined);

  assert.deepEqual(await retry(1), { kind: 'retry' });
  assert.equal(await handler(request, next), undefined);
  assert.deepEqual(await retry(2), { kind: 'retry' });

  maxRetries = 0;
  assert.equal(await handler({ ...request, step: 3 }, next), undefined);
  maxRetries = 1;
  const pending = handler({ ...request, step: 3 }, next);
  await Promise.resolve();
  controller.abort();
  assert.equal(await pending, undefined);

  const pendingOnUnload = handler({ ...request, signal: new AbortController().signal }, next);
  await Promise.resolve();
  dispose?.();
  assert.equal(await pendingOnUnload, undefined);
  assert.equal(listeners.has('agent/request-error'), false);
});
