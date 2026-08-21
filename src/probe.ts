/**
 * 代理连通性 + 延迟探测（移植自 dsh-net-proxy，TS 化）。
 *
 * probeProxy(proxy, opts)：
 *   1. TCP 连代理（测代理本身可达性 + TCP 延迟）
 *   2. 经代理对目标发一个请求（测完整链路 + HTTP 状态）
 *
 * 返回 { ok, connectMs, totalMs, httpStatus, target, error? }
 *   - ok:        代理可连且目标返回 <400
 *   - connectMs: 到代理的 TCP 握手耗时
 *   - totalMs:   整体耗时（含连接代理 + CONNECT/TLS + 请求 + 首包/响应）
 *   - httpStatus: 目标 HTTP 状态码（-1 表示未获得）
 */
import net from 'node:net';
import { proxiedFetch, type NetProxy } from './proxy-fetch.js';

const DEFAULT_TARGET = 'https://www.gstatic.com/generate_204';

/** 探测结果。 */
export interface ProbeResult {
  ok: boolean;
  target: string;
  connectMs: number;
  totalMs: number;
  httpStatus: number;
  error?: string;
}

/** 对配置的代理做一次连通 + 延迟探测。 */
export async function probeProxy(
  proxy: NetProxy,
  opts: { target?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const target = opts.target ?? DEFAULT_TARGET;
  const timeout = opts.timeout ?? 15000;
  const signal = opts.signal;
  const res: ProbeResult = { ok: false, target, connectMs: -1, totalMs: -1, httpStatus: -1 };
  const t0 = performance.now();
  try {
    // 1) TCP 到代理
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: proxy.host, port: proxy.port });
      const timer = setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          /* 忽略 */
        }
        reject(new Error('proxy TCP timeout'));
      }, timeout);
      const onAbort = (): void => {
        clearTimeout(timer);
        try {
          sock.destroy();
        } catch {
          /* 忽略 */
        }
        const e = new Error('aborted');
        (e as Error & { code: string }).code = 'ABORT_ERR';
        e.name = 'AbortError';
        reject(e);
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          sock.destroy();
          reject(
            Object.assign(new Error('aborted'), {
              code: 'ABORT_ERR',
              name: 'AbortError',
            }),
          );
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      sock.once('connect', () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        res.connectMs = Math.round(performance.now() - t0);
        sock.destroy();
        resolve();
      });
      sock.once('error', (e: Error) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(e);
      });
    });

    // 2) 经代理请求目标
    const r = await proxiedFetch(target, { method: 'GET', signal }, proxy, globalThis.fetch);
    res.httpStatus = r.status;
    res.totalMs = Math.round(performance.now() - t0);
    res.ok = res.httpStatus < 400;
    res.error = res.ok ? undefined : `target returned HTTP ${res.httpStatus}`;
  } catch (e) {
    res.totalMs = Math.round(performance.now() - t0);
    res.error = String((e && (e as Error).message) || e);
    if (e && (e as { code?: string }).code === 'ABORT_ERR') res.error = 'aborted';
  }
  return res;
}