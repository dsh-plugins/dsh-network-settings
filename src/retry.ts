/**
 * 请求自动重试纯逻辑。
 *
 * 这是「网络设置」中的「最大请求重试次数」能力：对任何经全局 fetch 的上游
 * 请求（LLM API 调用、web 搜索 / 抓取、外部 API 等），在网络层错误（undici
 * 连接失败 / 超时 / 复位等）或可重试状态码（429 / 5xx）时自动重试，至多
 * `maxRetries` 次，采用有界指数退避 + 抖动。
 *
 * 设计约束：
 * - 可重放 body（string / URLSearchParams / ArrayBuffer / Blob / FormData /
 *   无 body）才允许重试；ReadableStream 等不可重放 body 直接透传（第二次
 *   发送不可能）。
 * - 用户信号取消（AbortSignal）与 AbortError 一律不重试。
 * - 网络错误用一个 allowlist 判定，避免把参数类 `TypeError` 误判为可重试。
 */

/** 默认可重试 HTTP 状态码。 */
export const DEFAULT_RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** undici / 系统网络层可重试错误码 allowlist。 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET_CLOSED_BEFORE_CONNECTION',
  'UND_ERR_DESTROYED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
]);

/** 该错误是否为 AbortError（用户 / 外部取消）。 */
export function isAbortLike(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/** 沿 cause 链查找命中 allowlist 的网络错误码；无则返回 null。 */
export function retryableNetworkCode(err: unknown): string | null {
  let cursor: unknown = err;
  for (let i = 0; i < 8 && cursor !== null && typeof cursor === 'object'; i++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/** 是否属于可重试的网络层错误（AbortError 永不重试）。 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (isAbortLike(err)) return false;
  return retryableNetworkCode(err) !== null;
}

/**
 * body 是否可重放（重试意味着要再发一次同样的 body）。读取流不可重放。
 */
export function isReplayableBody(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body === 'string') return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  return false;
}

/** 有界指数退避：initial * 2^(attempt-1) 封顶 max，再乘 (1±jitter)。 */
export function retryDelayMs(
  attempt: number,
  opts?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number; random?: () => number },
): number {
  const initial = opts?.initialDelayMs ?? 500;
  const max = opts?.maxDelayMs ?? 10_000;
  const jitterRatio = opts?.jitterRatio ?? 0.1;
  const random = opts?.random ?? Math.random;
  const exponent = Math.min(Math.max(1, attempt) - 1, 16);
  const exponential = Math.min(initial * 2 ** exponent, max);
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random();
  return Math.min(exponential * jitter, max);
}

/** 可取消睡眠；signal 在等待中 abort 时以 AbortError 拒绝。 */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  (e as Error & { code: string }).code = 'ABORT_ERR';
  return e;
}

/** fetchWithRetry 的可选参数。 */
export interface FetchRetryOptions {
  /** 最大重试次数（0 = 不重试）。 */
  maxRetries: number;
  /** 可重试状态码集合，默认 {429,500,502,503,504}。 */
  retryableStatus?: ReadonlySet<number>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  /** 每次重试前的回调，用于日志。 */
  onRetry?: (attempt: number, info: { delayMs: number; status?: number; error?: unknown }) => void;
}

/**
 * 带自动重试的 fetch。`delegate` 是真正发出请求的函数（例如 UA + 代理包装
 * 后的 fetch）。对网络错误或可重试状态码，按退避重试至多 `maxRetries` 次；
 * 成功、耗尽、取消或不可重试错误则立即返回 / 抛出。
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  delegate: (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>,
  options: FetchRetryOptions,
): Promise<Response> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries || 0));
  if (maxRetries === 0) return delegate(input, init);
  if (!isReplayableBody(init?.body)) return delegate(input, init);

  const statuses = options.retryableStatus ?? DEFAULT_RETRYABLE_STATUS;
  const opts = options;

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await delegate(input, init);
      if (attempt >= maxRetries || !statuses.has(res.status)) return res;
      // 准备重发：释放上一个响应的连接资源。
      try {
        if (res.body && typeof (res.body as { cancel?: () => Promise<void> }).cancel === 'function') {
          await (res.body as { cancel: () => Promise<void> }).cancel();
        }
      } catch {
        /* 忽略清理失败 */
      }
      const delayMs = retryDelayMs(attempt + 1, opts);
      opts.onRetry?.(attempt + 1, { delayMs, status: res.status });
      await sleep(delayMs, init?.signal);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      if (init?.signal?.aborted || isAbortLike(err)) throw err;
      if (!isRetryableNetworkError(err)) throw err;
      const delayMs = retryDelayMs(attempt + 1, opts);
      opts.onRetry?.(attempt + 1, { delayMs, error: err });
      await sleep(delayMs, init?.signal);
    }
  }
}
