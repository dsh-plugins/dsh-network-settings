import { once } from 'node:events';
import { connect, type Socket } from 'node:net';

/** 代理地址、认证和请求限制。 */
export interface NetProxy {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  noProxy?: string[];
  /** 等待响应头或下一段数据的空闲超时（毫秒）。 */
  timeout?: number;
  /** 建立代理连接的超时（毫秒）。 */
  connectTimeout?: number;
}

async function readExactly(socket: Socket, size: number): Promise<Buffer> {
  while (!socket.destroyed && !socket.readableEnded) {
    const bytes = socket.read(size) as Buffer | null;
    if (bytes?.length === size) {
      return bytes;
    }
    if (bytes) {
      break;
    }
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        socket.off('readable', ready).off('end', ready).off('close', ready).off('error', failed);
      };
      const ready = () => {
        clean();
        resolve();
      };
      const failed = (error: Error) => {
        clean();
        reject(error);
      };
      socket.once('readable', ready).once('end', ready).once('close', ready).once('error', failed);
    });
  }
  throw Object.assign(new Error('SOCKS5 握手期间连接中断'), { code: 'ECONNRESET' });
}

/** 建立 SOCKS5 隧道，目标地址由代理解析。 */
export async function socksConnect(proxy: NetProxy, host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<Socket> {
  const socket = connect({ host: proxy.host, port: proxy.port, signal });
  const timer = setTimeout(() => {
    socket.destroy(Object.assign(new Error('SOCKS5 建连超时'), { code: 'ETIMEDOUT' }));
  }, timeoutMs);

  try {
    await once(socket, 'connect');
    const authenticate = Boolean(proxy.username || proxy.password);
    socket.write(Buffer.from([5, 1, authenticate ? 2 : 0]));
    const method = await readExactly(socket, 2);
    if (method[0] !== 5 || method[1] !== (authenticate ? 2 : 0)) {
      throw new Error('SOCKS5 代理拒绝认证方式');
    }

    if (authenticate) {
      const user = Buffer.from(proxy.username ?? '');
      const password = Buffer.from(proxy.password ?? '');
      if (user.length > 255 || password.length > 255) {
        throw new Error('SOCKS5 用户名或密码超过 255 字节');
      }
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
      const auth = await readExactly(socket, 2);
      if (auth[0] !== 1 || auth[1] !== 0) {
        throw new Error('SOCKS5 代理认证失败');
      }
    }

    const address = Buffer.from(host);
    if (address.length > 255) {
      throw new Error('SOCKS5 目标主机名超过 255 字节');
    }
    const targetPort = Buffer.alloc(2);
    targetPort.writeUInt16BE(port);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address, targetPort]));
    const reply = await readExactly(socket, 4);
    if (reply[0] !== 5 || reply[1] !== 0) {
      throw new Error(`SOCKS5 代理无法连接目标（状态 ${reply[1]}）`);
    }
    const addressType = reply[3];
    let addressLength: number;
    switch (addressType) {
      case 1: addressLength = 4; break;
      case 3: addressLength = (await readExactly(socket, 1))[0]; break;
      case 4: addressLength = 16; break;
      default: throw new Error('SOCKS5 代理返回了无效的地址类型');
    }
    await readExactly(socket, addressLength + 2);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
