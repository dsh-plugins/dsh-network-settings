/**
 * 请求自动重试纯逻辑测试（node --test，TypeScript 源）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWithRetry,
  isRetryableNetworkError,
  isReplayableBody,
  retryDelayMs,
  sleep,
  DEFAULT_RETRYABLE_STATUS,
} from '../lib/index.js';

/** 构造一个「前 n 次抛网错，之后成功」的 delegate。 */
function flakyNetwork(networkFailures: number, attemptsLog: number[]): (i: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let calls = 0;
  return async () => {
    calls += 1;
    attemptsLog.push(calls);
    if (calls <= networkFailures) {
      const e = new Error('fetch failed') as Error & { cause?: unknown };
      e.cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:1`), { code: 'ECONNREFUSED' });
      throw e;
    }
    return new Response('ok', { status: 200 });
  };
}

/** 构造一个按顺序返回状态码的 delegate。 */
function statusSequence(statuses: number[], attemptsLog: number[]): (i: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let calls = 0;
  return async () => {
    calls += 1;
    attemptsLog.push(calls);
    const status = statuses[Math.min(calls - 1, statuses.length - 1)] ?? 200;
    return new Response('body', { status });
  };
}

test('retryDelayMs：指数退避 + 抖动（random 固定 0.5 时无偏）', () => {
  const r = (): number => 0.5;
  assert.equal(retryDelayMs(1, { random: r }), 500);
  assert.equal(retryDelayMs(2, { random: r }), 1000);
  assert.equal(retryDelayMs(3, { random: r }), 2000);
  assert.equal(retryDelayMs(4, { random: r }), 4000);
  assert.equal(retryDelayMs(5, { random: r }), 8000);
  // 封顶 maxDelayMs
  assert.equal(retryDelayMs(10, { random: r, maxDelayMs: 10000 }), 10000);
  // 抖动上下界
  assert.equal(retryDelayMs(1, { random: () => 0 }), 450); // 1 - 0.1
  assert.equal(retryDelayMs(1, { random: () => 1 }), 550); // 1 + 0.1
});

test('isRetryableNetworkError：允许网络错误码，拒绝 AbortError / 无码错误', () => {
  assert.equal(isRetryableNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), false);
  assert.equal(isRetryableNetworkError(new TypeError('Failed to parse URL from x')), false);
});

test('isReplayableBody：可重放类型为 true，ReadableStream 为 false', () => {
  assert.equal(isReplayableBody(null), true);
  assert.equal(isReplayableBody('str'), true);
  assert.equal(isReplayableBody(new URLSearchParams({ a: '1' })), true);
  assert.equal(isReplayableBody(new Blob(['x'])), true);
  assert.equal(isReplayableBody(new Uint8Array([1, 2])), true);
  assert.equal(isReplayableBody(new ReadableStream()), false);
});

test('maxRetries=0：单次尝试直接返回', async () => {
  const log: number[] = [];
  const res = await fetchWithRetry('http://x', undefined, statusSequence([503, 200], log), { maxRetries: 0 });
  assert.equal(res.status, 503);
  assert.deepEqual(log, [1]);
});

test('网络错误：重试 2 次后成功', async () => {
  const log: number[] = [];
  const retries: number[] = [];
  const res = await fetchWithRetry('http://x', undefined, flakyNetwork(2, log), {
    maxRetries: 3,
    initialDelayMs: 0,
    maxDelayMs: 1,
    onRetry: (attempt) => retries.push(attempt),
  });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual(retries, [1, 2]);
});

test('网络错误耗尽：抛出最后一次错误', async () => {
  const log: number[] = [];
  const delegate = flakyNetwork(99, log);
  await assert.rejects(
    fetchWithRetry('http://x', undefined, delegate, { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 1 }),
    (err: unknown) => (err as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED',
  );
  assert.deepEqual(log, [1, 2, 3]);
});

test('可重试状态码：503 → 200', async () => {
  const log: number[] = [];
  const retries: Array<{ status?: number }> = [];
  const res = await fetchWithRetry('http://x', undefined, statusSequence([503, 200], log), {
    maxRetries: 2,
    initialDelayMs: 0,
    maxDelayMs: 1,
    onRetry: (_, info) => retries.push({ status: info.status }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(log, [1, 2]);
  assert.deepEqual(retries, [{ status: 503 }]);
});

test('429 属于默认可重试状态码', () => {
  assert.equal(DEFAULT_RETRYABLE_STATUS.has(429), true);
  assert.equal(DEFAULT_RETRYABLE_STATUS.has(500), true);
  assert.equal(DEFAULT_RETRYABLE_STATUS.has(502), true);
  assert.equal(DEFAULT_RETRYABLE_STATUS.has(503), true);
  assert.equal(DEFAULT_RETRYABLE_STATUS.has(504), true);
  assert.equal(DEFAULT_RETRYABLE_STATUS.has(400), false);
});

test('不可重试状态码（400）不重试', async () => {
  const log: number[] = [];
  const res = await fetchWithRetry('http://x', undefined, statusSequence([400, 200], log), {
    maxRetries: 3,
    initialDelayMs: 0,
    maxDelayMs: 1,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(log, [1]);
});

test('可重试状态码耗尽：返回最后一次响应', async () => {
  const log: number[] = [];
  const retries: number[] = [];
  const res = await fetchWithRetry('http://x', undefined, statusSequence([500, 500, 500, 200], log), {
    maxRetries: 2,
    initialDelayMs: 0,
    maxDelayMs: 1,
    onRetry: (attempt) => retries.push(attempt),
  });
  assert.equal(res.status, 500);
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual(retries, [1, 2]);
});

test('AbortError 不重试，原样抛出', async () => {
  const log: number[] = [];
  const delegate = async (): Promise<Response> => {
    log.push(1);
    throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
  };
  await assert.rejects(
    fetchWithRetry('http://x', undefined, delegate, { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 1 }),
    (err: unknown) => (err as { name?: string }).name === 'AbortError',
  );
  assert.deepEqual(log, [1]);
});

test('已 aborted 的 signal 不重试', async () => {
  const log: number[] = [];
  const controller = new AbortController();
  controller.abort();
  const delegate = async (): Promise<Response> => {
    log.push(1);
    throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(
    fetchWithRetry('http://x', { signal: controller.signal }, delegate, { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 1 }),
    /x/,
  );
  assert.deepEqual(log, [1]);
});

test('不可重放 body（ReadableStream）直接单次透传', async () => {
  const log: number[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  const delegate = async (): Promise<Response> => {
    log.push(1);
    throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(
    fetchWithRetry('http://x', { method: 'POST', body }, delegate, { maxRetries: 3 }),
    /x/,
  );
  assert.deepEqual(log, [1]);
});

test('sleep 在等待中 abort 时以 AbortError 拒绝', async () => {
  const controller = new AbortController();
  const pending = sleep(5_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (err: unknown) => (err as { name?: string }).name === 'AbortError');
});

test('sleep 已 abort 时立即拒绝，不再等待', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sleep(5_000, controller.signal),
    (err: unknown) => (err as { name?: string }).name === 'AbortError',
  );
});