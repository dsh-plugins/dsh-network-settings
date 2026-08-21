/**
 * 经已协商出 h2 的 TLS socket 发起 HTTP/2 请求，返回流式 + 解压 Response
 * （移植自 dsh-net-proxy，TS 化）。
 */
import http2 from 'node:http2';
import tls from 'node:tls';
import { ProxyError, abortError } from './errors.js';
import { makeBodyController } from './body.js';

type BodyLike = Buffer | string | { pipe(dest: unknown): unknown } | null | undefined;

/** 经已协商出 h2 的 TLS socket 发起 HTTP/2 请求，返回 Response（流式 + 解压）。 */
export async function sendViaHttp2(
  tlsSock: tls.TLSSocket,
  targetHost: string,
  targetPort: number,
  authority: string,
  urlObj: URL,
  method: string,
  headers: Record<string, string>,
  body: BodyLike,
  signal?: AbortSignal | null,
): Promise<Response> {
  void targetHost;
  void targetPort;
  const client = http2.connect(`https://${authority}`, { createConnection: () => tlsSock });
  const reqHeaders: Record<string, string> = {
    ':method': method,
    ':path': urlObj.pathname + urlObj.search,
    ':scheme': 'https',
    ':authority': authority,
    ...headers,
  };
  if (body != null && (Buffer.isBuffer(body) || typeof body === 'string')) {
    reqHeaders['content-length'] = String(Buffer.byteLength(body));
  }
  const req = client.request(reqHeaders);
  let onAbort: () => void = () => {};
  try {
    return await new Promise<Response>((resolve, reject) => {
      let done = false;
      const fin = (err: Error | null, resp?: Response): void => {
        if (done) return;
        done = true;
        err ? reject(err) : resolve(resp as Response);
      };
      onAbort = () => {
        fin(abortError());
        try {
          client.destroy();
        } catch {
          /* 忽略 */
        }
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('error', (e: Error) => fin(ProxyError('EHTTP2', `HTTP/2 request failed: ${e.message}`, e)));
      req.on('response', (h) => {
        try {
          const status = Number(h[':status']) || 0;
          const hdrs: Record<string, string> = {};
          for (const k of Object.keys(h)) {
            const lk = k.toLowerCase();
            if (lk === ':status') continue;
            const v = h[k];
            hdrs[lk] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          const ce = (hdrs['content-encoding'] || '').toLowerCase();
          const doDecode = ce === 'gzip' || ce === 'deflate' || ce === 'br';
          if (doDecode) delete hdrs['content-length'];
          if (status === 204 || status === 205 || status === 304) {
            const emptyResp = new Response(null, { status, headers: new Headers(hdrs) });
            Object.defineProperty(emptyResp, 'url', { value: urlObj.href });
            try {
              client.close();
            } catch {
              /* 忽略 */
            }
            fin(null, emptyResp);
            return;
          }
          const streamBody = new ReadableStream<Uint8Array>({
            start(c) {
              const sink = makeBodyController(c, ce);
              req.on('data', (d: unknown) => {
                if (sink.dec) {
                  if (!sink.dec.write(d as Buffer)) req.pause();
                } else {
                  try {
                    c.enqueue(new Uint8Array(d as Uint8Array));
                  } catch {
                    /* 已关闭等情况忽略 */
                  }
                }
              });
              if (sink.dec) sink.dec.on('drain', () => req.resume());
              req.on('end', () => {
                sink.finish();
                try {
                  client.close();
                } catch {
                  /* 忽略 */
                }
              });
              req.on('error', (e: Error) => {
                sink.destroy();
                try {
                  c.error(e);
                } catch {
                  /* 已 error 等情况忽略 */
                }
              });
            },
          });
          const resp = new Response(streamBody, { status, headers: new Headers(hdrs) });
          Object.defineProperty(resp, 'url', { value: urlObj.href });
          fin(null, resp);
        } catch (e) {
          fin(ProxyError('EHTTP2', `HTTP/2 response parse failed: ${String((e as Error)?.message ?? e)}`, e));
        }
      });
      if (body != null && (Buffer.isBuffer(body) || typeof body === 'string')) {
        req.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
      } else if (body != null && typeof (body as { pipe?: unknown }).pipe === 'function') {
        (body as { pipe(dest: unknown): unknown }).pipe(req);
      } else {
        req.end();
      }
    });
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}