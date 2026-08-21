/**
 * 代理客户端聚合入口（纯 re-export）。
 *
 * 实现拆分至 src/proxy/：
 *   errors.ts    结构化错误与公共工具（ProxyError/abortError/timeoutFor）
 *   no-proxy.ts  NO_PROXY 直连判定
 *   parse.ts     协议解析（createDecoder/parseStatusLine）
 *   body.ts      公共响应体解码 sink（makeBodyController）
 *   conn.ts      代理底层连接 + ByteStream 数据泵
 *   http11.ts    HTTP/1.1 请求（sendViaSocket）
 *   http2.ts     HTTP/2 请求（sendViaHttp2）
 *   request.ts   proxiedFetch 入口（直连判定/协议分发/重定向）
 */
export { proxiedFetch } from './proxy/request.js';
export type { FetchInput, OriginalFetch } from './proxy/request.js';
export { isNoProxy } from './proxy/no-proxy.js';
export { createDecoder, parseStatusLine } from './proxy/parse.js';
export { ByteStream } from './proxy/conn.js';
export type { NetProxy } from './proxy/conn.js';