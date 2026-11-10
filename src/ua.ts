/**
 * User-Agent 改写纯逻辑（移植自 @dsh-plugin/dsh-user-agent）。
 *
 * 本模块只包含无副作用的纯函数，便于 node --test 直接针对 lib 输出测试，
 * 不依赖任何 live cordis / fetch 环境。
 */

/** 默认 User-Agent，对应 dsh 自身的 attribution baseline。 */
export const DEFAULT_UA = 'DeepSeek-Harness/0.1 (+https://github.com/deepseek-ai/dsh)';

/** fetch 类型（对齐 DOM lib）。 */
export type FetchType = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** UA 改写策略（来自网络设置命名空间中 UA 块字段）。 */
export interface UaPolicy {
  uaEnabled?: boolean;
  userAgent?: string;
}

/**
 * 构造新的 `RequestInit`，将 `user-agent` 头固定为 `ua`，其余请求部分
 * 保留。若调用方没有覆盖请求头，则继承 Request 自带的请求头。
 */
export function applyUserAgent(init: RequestInit | undefined, ua: string, input?: RequestInfo | URL): RequestInit {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('user-agent', ua);
  return { ...init, headers };
}

/**
 * 当前「网络设置」策略是否要求改写 UA（开启且 UA 非空）。纯函数。
 */
export function shouldRewriteUA(policy: UaPolicy | undefined): policy is { uaEnabled: true; userAgent: string } {
  return (
    policy !== undefined &&
    policy.uaEnabled === true &&
    typeof policy.userAgent === 'string' &&
    policy.userAgent.trim().length > 0
  );
}
