/**
 * 结构化错误与公共工具（移植自 dsh-net-proxy，TS 化）。
 */

/** 带机器可读 code 的错误。 */
export interface NetProxyError extends Error {
  code?: string;
}

/** 构造带 code 的错误；可选携带 cause。 */
export function ProxyError(code: string, message: string, cause?: unknown): NetProxyError {
  const e = new Error(message) as NetProxyError;
  e.code = code;
  if (cause !== undefined) (e as Error & { cause?: unknown }).cause = cause;
  return e;
}

/** 对齐 fetch 的取消错误。 */
export function abortError(): NetProxyError {
  const e = new Error('The operation was aborted.') as NetProxyError;
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

/** 超时（ms）：proxy.timeout 可用则用之，否则默认 60000。 */
export function timeoutFor(proxy: { timeout?: number } | undefined): number {
  const t = Number(proxy?.timeout);
  return Number.isFinite(t) && t > 0 ? t : 60000;
}