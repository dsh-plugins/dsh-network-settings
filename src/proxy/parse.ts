/**
 * 协议解析小工具（纯函数，移植自 dsh-net-proxy，TS 化）。
 */
import zlib from 'node:zlib';

/** 根据 content-encoding 创建解压流；不支持/无编码时返回 null。 */
export function createDecoder(ce: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  if (ce === 'gzip') return zlib.createGunzip();
  if (ce === 'deflate') return zlib.createInflate();
  if (ce === 'br') return zlib.createBrotliDecompress();
  return null;
}

/** 解析 HTTP 状态行，返回 status。 */
export function parseStatusLine(line: string): number {
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(line || '');
  return m ? Number(m[1]) : 0;
}