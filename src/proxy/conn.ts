/**
 * 代理底层连接：TCP 连接代理 → HTTP CONNECT / SOCKS5 隧道；单数据泵 ByteStream
 * （移植自 dsh-net-proxy，TS 化）。
 */
import net from 'node:net';
import { ProxyError, abortError } from './errors.js';
import { parseStatusLine } from './parse.js';

/** 单行头上限。 */
export const MAX_HEADER_LINE = 64 * 1024;

/** 代理配置契约。`protocol`：「http」/「socks5」/「socks」；`username`/`password` 可选。 */
export interface NetProxy {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  noProxy?: string[];
  timeout?: number;
}

/** 连接到代理（可取消）。 */
export function connectProxy(proxy: NetProxy, signal?: AbortSignal | null): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    sock.setNoDelay(true);
    const onAbort = (): void => {
      try {
        sock.destroy();
      } catch {
        /* 忽略 */
      }
      reject(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        sock.destroy();
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = (err: Error | null, val: net.Socket): void => {
      if (signal) signal.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve(val);
    };
    sock.once('connect', () => done(null, sock));
    sock.once('error', (e: Error) =>
      done(ProxyError('ECONNECT_PROXY', `proxy connect ${proxy.host}:${proxy.port} failed: ${e.message}`, e), sock));
  });
}

function proxyAuthHeader(proxy: NetProxy): string {
  if (!proxy.username && !proxy.password) return '';
  return 'Proxy-Authorization: Basic ' + Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64') + '\r\n';
}

/** HTTP 代理 CONNECT 隧道（HTTPS 目标）。成功返回 raw socket。 */
export function httpConnect(
  proxy: NetProxy,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal | null,
): Promise<net.Socket> {
  return new Promise(async (resolve, reject) => {
    let sock: net.Socket;
    try {
      sock = await connectProxy(proxy, signal);
    } catch (e) {
      reject(e);
      return;
    }
    const host = `${targetHost}:${targetPort}`;
    const stream = new ByteStream(sock);
    sock.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${proxyAuthHeader(proxy)}\r\n`);
    try {
      const statusLine = await stream.readLine();
      stream.detach();
      const status = parseStatusLine(statusLine);
      if (status === 200) resolve(sock);
      else {
        sock.destroy();
        reject(ProxyError('ECONNECT_TARGET', `CONNECT to ${host} via proxy failed: HTTP ${status}`));
      }
    } catch (e) {
      stream.detach();
      sock.destroy();
      reject(e);
    }
  });
}

/** SOCKS5：协商（支持 RFC1929 用户名/密码）+ CONNECT。成功返回 raw socket。 */
export function socksConnect(
  proxy: NetProxy,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal | null,
): Promise<net.Socket> {
  return new Promise(async (resolve, reject) => {
    let sock: net.Socket;
    try {
      sock = await connectProxy(proxy, signal);
    } catch (e) {
      reject(e);
      return;
    }
    const fail = (msg: string): void => {
      sock.destroy();
      reject(ProxyError('ECONNECT_TARGET', msg));
    };
    try {
      const stream = new ByteStream(sock);
      // 方法协商：0x00 no-auth（若无凭据）/ 0x02 user/pass（若有凭据）
      const wantAuth = !!(proxy.username || proxy.password);
      sock.write(Buffer.from([0x05, 0x01, wantAuth ? 0x02 : 0x00]));
      const verMethod = await stream.readExactly(2);
      if (verMethod[0] !== 0x05) {
        stream.detach();
        fail(`SOCKS5: bad version ${verMethod[0]}`);
        return;
      }
      if (verMethod[1] === 0x02) {
        const user = Buffer.from(proxy.username || '', 'utf8');
        const pass = Buffer.from(proxy.password || '', 'utf8');
        sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const authResp = await stream.readExactly(2);
        if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
          stream.detach();
          fail(`SOCKS5: auth failed (code ${authResp[1]})`);
          return;
        }
      } else if (verMethod[1] !== 0x00) {
        stream.detach();
        fail(`SOCKS5: server requires auth (method ${verMethod[1]})`);
        return;
      }
      // CONNECT：统一用域名形式（ATYP=0x03）
      const hostBuf = Buffer.from(targetHost, 'utf8');
      const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x03;
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      sock.write(req);
      const head = await stream.readExactly(4);
      if (head[1] !== 0x00) {
        stream.detach();
        fail(`SOCKS5: connect to ${targetHost}:${targetPort} failed, code ${head[1]}`);
        return;
      }
      // 吃掉 BND.ADDR
      const atyp = head[3];
      const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1;
      await stream.readExactly(alen + 2);
      stream.detach();
      resolve(sock);
    } catch (e) {
      sock.destroy();
      reject(e);
    }
  });
}

/**
 * 单数据泵 ByteStream：socket 只挂一套 data/end/error 监听，数据进队列，
 * 用 pull 式解析（不足则挂起）。避免多监听器互相消费丢数据；合并计算推延，
 * 减少 O(n²) 反复 concat。
 */
export class ByteStream {
  sock: net.Socket;
  q: Buffer[] = [];
  len = 0;
  waiters: Array<() => void> = [];
  ended = false;
  error: Error | null = null;
  private _idleTimer: NodeJS.Timeout | null = null;
  private readonly _onData: (c: Buffer) => void;
  private readonly _onEnd: () => void;
  private readonly _onErr: (e: Error) => void;
  private readonly _onIdleClear: (() => void) | null = null;

  constructor(sock: net.Socket, idleMs = 0) {
    this.sock = sock;
    // 保存处理器引用，供 detach() 在把 socket 交给 TLS 前移除
    this._onData = (c) => this._push(c);
    this._onEnd = () => {
      this.ended = true;
      this._flush();
    };
    this._onErr = (e) => {
      this.error = e;
      this.ended = true;
      this._flush();
    };
    sock.on('data', this._onData);
    sock.on('end', this._onEnd);
    sock.on('error', this._onErr);
    if (idleMs > 0) {
      const onIdle = (): void => {
        try {
          sock.destroy();
        } catch {
          /* 忽略 */
        }
        this.error = ProxyError('ETIMEOUT', 'proxiedFetch: response idle timeout');
        this.ended = true;
        this._flush();
      };
      const reset = (): void => {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(onIdle, idleMs);
      };
      this._onIdleClear = () => {
        if (this._idleTimer) clearTimeout(this._idleTimer);
      };
      reset();
      sock.on('data', reset);
      sock.on('end', this._onIdleClear);
      sock.on('close', this._onIdleClear);
    }
  }

  /** 把 socket「交还」给 TLS 等接管前调用：移除本流挂上的全部监听。 */
  detach(): void {
    const s = this.sock;
    s.removeListener('data', this._onData);
    s.removeListener('end', this._onEnd);
    s.removeListener('error', this._onErr);
    if (this._onIdleClear) {
      s.removeListener('data', this._onIdleClear);
      s.removeListener('end', this._onIdleClear);
      s.removeListener('close', this._onIdleClear);
    }
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  private _push(c: Buffer): void {
    this.q.push(c);
    this.len += c.length;
    this._flush();
  }

  /** 唤醒等待者（http11 的取消路径也需要触发挂起的读取）。 */
  _flush(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** 从队列头部精确切出 need 字节（need=null 取全部）。多余的部分留在队列。 */
  private _take(need: number | null): Buffer {
    if (this.len === 0) return Buffer.alloc(0);
    const needN = need == null ? this.len : need;
    const parts: Buffer[] = [];
    let have = 0;
    let i = 0;
    let done = false;
    for (; i < this.q.length; i++) {
      const c = this.q[i];
      const want = needN - have;
      if (c.length > want) {
        // 该块超出 need：取 want，剩余放回队列
        parts.push(c.subarray(0, want));
        const rest = c.subarray(want);
        this.q = [rest, ...this.q.slice(i + 1)];
        this.len -= want;
        return Buffer.concat(parts);
      }
      parts.push(c);
      have += c.length;
      if (have >= needN) {
        i++;
        done = true;
        break;
      }
    }
    this.q = this.q.slice(done ? i : this.q.length);
    this.len -= have;
    return Buffer.concat(parts);
  }

  private _pull(need: number, cb: (err: Error | null, buf: Buffer | null) => void): void {
    if (this.len >= need) cb(null, this._take(need));
    else if (this.ended) cb(this.error || ProxyError('ERESP_END', 'socket ended early'), null);
    else this.waiters.push(() => this._pull(need, cb));
  }

  readExactly(need: number): Promise<Buffer> {
    return new Promise((res, rej) =>
      this._pull(need, (e, b) => (e ? rej(e) : res(b as Buffer))),
    );
  }

  /** 读一行（到 CRLF），带最大长度限制。换行之后多读的数据放回队列。 */
  async readLine(): Promise<string> {
    let scan: Buffer = Buffer.alloc(0);
    for (;;) {
      if (this.len > 0) {
        const take = this._take(this.len);
        scan = scan.length ? Buffer.concat([scan, take]) : take;
      }
      const idx = scan.indexOf('\r\n');
      if (idx !== -1) {
        const out = scan.subarray(0, idx);
        const rest = scan.subarray(idx + 2);
        if (rest.length > 0) this._prepend(rest);
        return out.toString('latin1');
      }
      if (scan.length > MAX_HEADER_LINE) throw ProxyError('EHEADER', 'response header line too long');
      if (this.ended) throw (this.error || ProxyError('ERESP_END', 'socket ended'));
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  private _prepend(buf: Buffer): void {
    if (buf && buf.length) {
      this.q.unshift(buf);
      this.len += buf.length;
    }
  }

  /** 下一块数据（若有多块合并成一块返回）；结束返回 null。 */
  private _nextBlock(cb: (err: Error | null, buf: Buffer | null) => void): void {
    if (this.len > 0) {
      const out = this._take(this.len);
      cb(null, out);
      return;
    }
    if (this.ended) cb(this.error || null, null);
    else this.waiters.push(() => this._nextBlock(cb));
  }

  nextData(): Promise<Buffer | null> {
    return new Promise((res, rej) =>
      this._nextBlock((e, b) => (e ? rej(e) : res(b))),
    );
  }
}