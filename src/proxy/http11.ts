/**
 * 经已建立 socket 的 HTTP/1.1 请求：读状态行+响应头，流式响应体
 * （chunked/content-length + 解压）（移植自 dsh-net-proxy，TS 化）。
 */
import net from 'node:net';
import { ProxyError, abortError } from './errors.js';
import { parseStatusLine } from './parse.js';
import { ByteStream } from './conn.js';
import { makeBodyController } from './body.js';

/** 响应头数量上限。 */
export const MAX_HEADERS = 256;
/** 单个 chunk 上限 64MB（防恶意超大 size）。 */
export const MAX_CHUNK = 64 * 1024 * 1024;

/** 可发送的 body 形状：字节 / 字符串 / 可 pipe 流。 */
export type BodyLike = Buffer | string | { pipe(dest: net.Socket): unknown } | null | undefined;

/** 发送 HTTP/1.1 请求并返回流式 Response（解压 + 无 body 短路）。 */
export async function sendViaSocket(
  sock: net.Socket,
  url: string,
  head: string,
  body: BodyLike,
  opts: { signal?: AbortSignal | null; timeoutMs?: number },
): Promise<Response> {
  const isPipe = body != null && typeof (body as { pipe?: unknown }).pipe === 'function';
  let reqPacket: Buffer;
  if (body == null || isPipe) {
    reqPacket = Buffer.from(head, 'latin1');
  } else {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body as string);
    reqPacket = Buffer.concat([Buffer.from(head, 'latin1'), bytes]);
    if (!/content-length:/i.test(head)) {
      const cl = Buffer.byteLength(bytes);
      reqPacket = Buffer.concat([
        Buffer.from(head.replace(/\r\n\r\n$/, `\r\nContent-Length: ${cl}\r\n\r\n`), 'latin1'),
        bytes,
      ]);
    }
  }
  const stream = new ByteStream(sock, opts.timeoutMs);

  const onAbort = (): void => {
    try {
      sock.destroy();
    } catch {
      /* 忽略 */
    }
    stream.error = abortError();
    stream.ended = true;
    stream._flush();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      try {
        sock.destroy();
      } catch {
        /* 忽略 */
      }
      throw abortError();
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  sock.write(reqPacket);
  if (body != null && typeof (body as { pipe?: unknown }).pipe === 'function') {
    (body as { pipe(dest: net.Socket): unknown }).pipe(sock);
  }

  try {
    // 读状态行 + 头（单泵）
    const statusLine = await stream.readLine();
    let n = 0;
    const headerLines: string[] = [];
    for (;;) {
      const line = await stream.readLine();
      if (line === '') break;
      headerLines.push(line);
      if (++n > MAX_HEADERS) {
        try {
          sock.destroy();
        } catch {
          /* 忽略 */
        }
        throw ProxyError('EHEADER', 'too many response headers');
      }
    }

    const status = parseStatusLine(statusLine);
    const hdrs: Record<string, string> = {};
    for (const line of headerLines) {
      const ci = line.indexOf(':');
      if (ci === -1) continue;
      hdrs[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }

    // ── 流式响应体：逐块 enqueue；若 gzip/br/deflate 则流式解压 ──
    const ce = (hdrs['content-encoding'] || '').toLowerCase();
    const doDecode = ce === 'gzip' || ce === 'deflate' || ce === 'br';
    // 本地解压后 content-length 不再匹配 → 移除；content-encoding 保留（兼容 fetch 语义）
    if (doDecode) delete hdrs['content-length'];

    const reqMethod = head.split(' ')[0].toUpperCase();
    if (status === 204 || status === 205 || status === 304 || reqMethod === 'HEAD') {
      // 无 body 状态码：标准 fetch 返回空 Response，及早关闭连接不再读 body
      try {
        sock.destroy();
      } catch {
        /* 忽略 */
      }
      const sm = statusLine.match(/^HTTP\/\d\.\d \d{3}(?: (.+))?$/);
      const emptyResp = new Response(null, {
        status,
        statusText: (sm && sm[1] ? sm[1] : '').trim(),
        headers: new Headers(hdrs),
      });
      Object.defineProperty(emptyResp, 'url', { value: url });
      return emptyResp;
    }

    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        (async () => {
          const sink = makeBodyController(controller, ce);
          try {
            const te = (hdrs['transfer-encoding'] || '').toLowerCase();
            if (te.includes('chunked')) {
              for (;;) {
                const line = await stream.readLine();
                const size = parseInt(line.trim().split(';')[0], 16);
                if (!Number.isFinite(size) || size <= 0) break;
                if (size > MAX_CHUNK) {
                  try {
                    sock.destroy();
                  } catch {
                    /* 忽略 */
                  }
                  throw ProxyError('ECHUNK', 'chunk too large');
                }
                const chunk = await stream.readExactly(size);
                await sink.write(chunk);
                await stream.readLine(); // 尾部 CRLF
              }
            } else {
              const hasCl = /^\d+$/.test((hdrs['content-length'] || '').trim());
              let rem = hasCl ? Number(hdrs['content-length']) : -1;
              for (;;) {
                const d = await stream.nextData();
                if (d === null) break;
                let toPush = d;
                if (rem >= 0) {
                  if (d.length >= rem) {
                    toPush = d.subarray(0, rem);
                    rem = 0;
                  } else rem -= d.length;
                }
                await sink.write(toPush);
                if (rem === 0) break;
              }
            }
            await sink.finish();
          } catch (e) {
            sink.destroy();
            try {
              controller.error(e);
            } catch {
              /* 已 error 等情况忽略 */
            }
          } finally {
            try {
              sock.destroy();
            } catch {
              /* 忽略 */
            }
          }
        })();
      },
    });

    const m = statusLine.match(/^HTTP\/\d\.\d \d{3}(?: (.+))?$/);
    const statusText = (m && m[1] ? m[1] : '').trim();
    const response = new Response(streamBody, { status, statusText, headers: new Headers(hdrs) });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}