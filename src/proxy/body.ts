/**
 * HTTP/1.1 与 HTTP/2 共用的响应体解码 sink（移植自 dsh-net-proxy，TS 化）。
 *
 * 两者都以「按 content-encoding 建解码器 → dec.on(data) enqueue →
 * dec.on(end) close / dec.on(error) error → dec.end() 收尾」的方式把压缩字节
 * 解压进 ReadableStream controller。此模块把这段公共逻辑抽成一份。
 */
import zlib from 'node:zlib';
import { createDecoder } from './parse.js';

/** 可写块类型（Buffer / Uint8Array 均可用）。 */
type Chunk = Buffer | Uint8Array;

/** 解码流联合。 */
type Decoder = zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;

/** 解码 sink 的公共接口。 */
export interface BodySink {
  /** 解码流（无编码时为 null）。 */
  dec: Decoder | null;
  /** 写入一块原始字节（Promise，带 decoder drain 背压）；无编码时直接 enqueue。 */
  write(chunk: Chunk): Promise<void>;
  /** 收尾：dec.end() 冲刷后 close controller（无解码则直接 close）。 */
  finish(): Promise<void>;
  /** 关闭 controller（幂等）。 */
  close(): void;
  /** 销毁解码流（错误路径清理）。 */
  destroy(): void;
}

/**
 * 构建「解压解码器 → ReadableStream controller」的公共 sink，供 HTTP/1.1 与
 * HTTP/2 响应体复用。屏蔽 gzip/deflate/br 与无编码两种路径。
 *
 * @param controller 目标流控制器
 * @param ce content-encoding（小写）
 */
export function makeBodyController(
  controller: ReadableStreamDefaultController<Uint8Array>,
  ce: string,
): BodySink {
  const dec = createDecoder(ce);
  let decDoneResolve: (() => void) | null = null;
  const decDone = new Promise<void>((r) => {
    decDoneResolve = r;
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      /* 已关闭等情况忽略 */
    }
    decDoneResolve?.();
  };
  if (dec) {
    dec.on('data', (c: unknown) => {
      try {
        controller.enqueue(new Uint8Array(c as Uint8Array));
      } catch {
        /* 已关闭等情况忽略 */
      }
    });
    dec.on('end', close);
    dec.on('error', (e: Error) => {
      try {
        controller.error(e);
      } catch {
        /* 已 error 等情况忽略 */
      }
      decDoneResolve?.();
    });
  }
  // dec 写入用 drain 背压，避免过大解压缓冲；无解码直接 enqueue。
  const write = (c: Chunk): Promise<void> =>
    new Promise((res) => {
      if (dec) {
        if (!dec.write(c)) {
          dec.once('drain', () => res());
        } else {
          res();
        }
      } else {
        try {
          controller.enqueue(new Uint8Array(c));
        } catch {
          /* 已关闭等情况忽略 */
        }
        res();
      }
    });
  const finish = (): Promise<void> => {
    if (dec) {
      dec.end();
      return decDone;
    }
    close();
    return Promise.resolve();
  };
  const destroy = (): void => {
    if (dec) {
      try {
        dec.destroy();
      } catch {
        /* 忽略 */
      }
    }
  };
  return { dec, write, finish, close, destroy };
}