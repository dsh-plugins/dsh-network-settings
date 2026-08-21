/**
 * proxiedFetch 入口：直连判定、请求头组装、https/http 协议分发、重定向跟随
 * （移植自 dsh-net-proxy，TS 化）。
 */
import net from 'node:net';
import tls from 'node:tls';
import { ProxyError, timeoutFor } from './errors.js';
import { connectProxy, httpConnect, socksConnect, type NetProxy } from './conn.js';
import { sendViaSocket, type BodyLike } from './http11.js';
import { sendViaHttp2 } from './http2.js';
import { isNoProxy } from './no-proxy.js';

/** 原始 fetch 形状（dsh 的全局 fetch）。 */
export type OriginalFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** proxiedFetch 可接受的 input：字符串 URL 或带 url 的对象。 */
export type FetchInput = string | { url?: string; method?: string };

/** 可直接 pipe 的 body 形状。 */
type PipeableBody = { pipe(dest: unknown): unknown };

function directFetch(originalFetch: OriginalFetch, input: FetchInput, init?: RequestInit): Promise<Response> {
  return originalFetch(input as string, init);
}

/** 将 RequestInit.body 归一化成可二次使用的字节/字符串/流。 */
function normalizeBody(init: RequestInit): BodyLike {
  const b = init.body;
  if (b == null) return null;
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  if (typeof b === 'string') return Buffer.from(b);
  return b as unknown as PipeableBody;
}

async function proxiedOnce(
  url: string,
  init: RequestInit,
  proxy: NetProxy,
  originalFetch: OriginalFetch,
): Promise<Response> {
  const urlObj = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = normalizeBody(init);
  const signal = init.signal;

  if (isNoProxy(url, proxy.noProxy)) {
    return directFetch(originalFetch, url, init);
  }

  const targetHostRaw = urlObj.hostname; // IPv6 形如 [::1]
  const targetHost = targetHostRaw.startsWith('[') && targetHostRaw.endsWith(']') ? targetHostRaw.slice(1, -1) : targetHostRaw;
  const defaultPort = urlObj.protocol === 'https:' ? 443 : 80;
  const targetPort = urlObj.port ? Number(urlObj.port) : defaultPort;
  // A1：Host 头默认端口省略；非默认才带 `:port`
  const hostHeader = targetPort === defaultPort ? targetHostRaw : `${targetHostRaw}:${targetPort}`;
  const isSocks = proxy.protocol === 'socks5' || proxy.protocol === 'socks';

  // 组装请求头：正确处理 Headers 实例（forEach 才能取到内部 slot 的值）
  const headers: Record<string, string> = {};
  {
    const src = init.headers;
    if (src != null && typeof src === 'object') {
      if (typeof Headers !== 'undefined' && src instanceof Headers) {
        src.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(src)) {
        for (const [k, v] of src) headers[k] = String(v);
      } else {
        Object.assign(headers, src);
      }
    }
  }
  // 移除 hop-by-hop；A5：host 一律以计算值为准
  ['proxy-connection', 'keep-alive', 'connection', 'upgrade', 'transfer-encoding', 'host', 'content-length', 'accept-encoding'].forEach(
    (h) => delete headers[h],
  );
  // A4：尊重调用方显式 accept-encoding；未设置才默认 identity
  let declaredAE: string | null = null;
  {
    const src = init.headers;
    if (src != null && typeof src === 'object') {
      if (typeof Headers !== 'undefined' && src instanceof Headers) declaredAE = src.get('accept-encoding');
      else if (Array.isArray(src)) {
        const f = src.find((x) => String(x[0]).toLowerCase() === 'accept-encoding');
        declaredAE = f ? String(f[1]) : null;
      } else if ('accept-encoding' in src) {
        declaredAE = String((src as Record<string, unknown>)['accept-encoding']);
      }
    }
  }
  headers['accept-encoding'] = declaredAE != null && String(declaredAE).trim() !== '' ? String(declaredAE) : 'identity';

  let raw: net.Socket;
  try {
    if (urlObj.protocol === 'https:') {
      raw = isSocks ? await socksConnect(proxy, targetHost, targetPort, signal) : await httpConnect(proxy, targetHost, targetPort, signal);
    } else if (urlObj.protocol !== 'http:') {
      throw ProxyError('EPROTO', `unsupported protocol ${urlObj.protocol}`);
    } else {
      raw = await connectProxy(proxy, signal);
    }
  } catch (e) {
    if (e && (e as { name?: string }).name === 'AbortError') throw e;
    throw e;
  }

  if (urlObj.protocol === 'https:') {
    // B3：IP 目标不发 SNI
    const isIP = net.isIP(targetHost);
    const tlsSock = tls.connect({
      socket: raw,
      servername: isIP ? undefined : targetHost,
      host: targetHost,
      port: targetPort,
      ALPNProtocols: ['h2', 'http/1.1'], // C2：协商 HTTP/2
    });
    await new Promise<void>((resolve, reject) => {
      tlsSock.once('secureConnect', () => {
        tlsSock.removeAllListeners('error');
        resolve();
      });
      tlsSock.once('error', (e: Error) => reject(ProxyError('ETLS', `TLS to ${targetHost} failed: ${e.message}`, e)));
    });
    if (tlsSock.alpnProtocol === 'h2') {
      // C2：服务器协商出 HTTP/2 → 走 HTTP/2；否则回退 HTTP/1.1
      return sendViaHttp2(tlsSock, targetHost, targetPort, hostHeader, urlObj, method, headers, body, signal);
    }
    const path = urlObj.pathname + urlObj.search;
    const h = { Host: hostHeader, Connection: 'close', ...headers };
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    return sendViaSocket(tlsSock, url, head, body, { signal, timeoutMs: timeoutFor(proxy) });
  }

  // HTTP 目标：绝对 URL + Host；有凭据时补 Proxy-Authorization（A3）
  const sock = raw;
  const absUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
  const proxyAuth = proxy.username || proxy.password
    ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64') }
    : {};
  const h = { Host: urlObj.host, Connection: 'close', ...proxyAuth, ...headers };
  const head = `${method} ${absUrl} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
  return sendViaSocket(sock, url, head, body, { signal, timeoutMs: timeoutFor(proxy) });
}

// 外层：跟随 30x 重定向（最多 5 跳），对齐标准 fetch。
export async function proxiedFetch(
  input: FetchInput,
  init: RequestInit = {},
  proxy: NetProxy,
  originalFetch: OriginalFetch,
): Promise<Response> {
  let url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url) throw new Error('proxiedFetch: invalid input');
  let cur: RequestInit = { ...(init || {}) };
  if (input && typeof input === 'object' && input.url && !cur.method) cur.method = input.method || 'GET';
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await proxiedOnce(url, cur, proxy, originalFetch);
      const st = resp.status;
      if (st === 301 || st === 302 || st === 303 || st === 307 || st === 308) {
        const loc = resp.headers ? resp.headers.get('location') : null;
        if (loc) {
          const next = new URL(loc, url).href;
          const curMethod = (cur.method || 'GET').toUpperCase();
          const toGet = st === 303 || ((st === 301 || st === 302) && curMethod !== 'HEAD');
          cur = { ...cur, method: toGet ? 'GET' : curMethod };
          if (toGet) delete cur.body;
          try {
            if (resp.body && typeof (resp.body as { cancel?: () => Promise<void> }).cancel === 'function') {
              await (resp.body as { cancel: () => Promise<void> }).cancel();
            }
          } catch {
            /* 忽略 */
          }
          url = next;
          continue;
        }
      }
      return resp;
    } catch (e) {
      if (e && (e as { name?: string }).name === 'AbortError') throw e;
      throw e;
    }
  }
  throw ProxyError('EREDIRECT', 'proxiedFetch: too many redirects');
}