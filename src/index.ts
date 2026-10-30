/** Network policies use loader 2.0 config handles; form rendering and storage are loader-owned. */
import type { CordisContext, HostAPI } from '@dsh-plugin/dsh-loader';
import { createConfigTemplate } from './config-template.js';
type Context = CordisContext & { dshLoader: HostAPI; logger: Required<NonNullable<CordisContext['logger']>> };
import { existsSync } from 'node:fs';
import z from 'schemastery';
import { proxiedFetch } from './proxy-fetch.js';
import { probeProxy } from './probe.js';
import { toProxy, loadConfig, configPath } from './legacy-config.js';
import { fetchWithRetry } from './retry.js';
import { applyUserAgent, shouldRewriteUA, DEFAULT_UA, type FetchType } from './ua.js';

// ── 公共纯函数 re-export（测试 / 复用）──
export { applyUserAgent, shouldRewriteUA, DEFAULT_UA } from './ua.js';
export {
  fetchWithRetry,
  isRetryableNetworkError,
  isReplayableBody,
  retryDelayMs,
  DEFAULT_RETRYABLE_STATUS,
  sleep,
  type FetchRetryOptions,
} from './retry.js';
export { isNoProxy, proxiedFetch } from './proxy-fetch.js';
export type { NetProxy } from './proxy-fetch.js';
export { probeProxy, type ProbeResult } from './probe.js';

/** Cordis / npm 插件名（loader 诊断用）。 */
export const name = '@dsh-plugin/dsh-network-settings';

/** 稳定命名空间 id（仅允许 [a-z0-9-]，config-api 配置目录 ID）。 */
export const PLUGIN_ID = 'dsh-network-settings';

/** 代理协议支持列表（与 dsh-net-proxy 保持一致）。 */
export const PROXY_PROTOCOLS = ['http', 'socks5'] as const;

/** 默认 NO_PROXY（回环直连）。 */
export const DEFAULT_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];

/**
 * 「网络设置」插件配置 / settings schema。字段默认值在此，供 UI 渲染。
 * 三块：ua *（UA 设置）、proxy *（网络代理）、retryEnabled + maxRetries（请求重试）。
 */
export const Config = z.object({
  // ── UA 设置 ──
  /** UA 改写主开关：关闭时原样透传调用方的 User-Agent。 */
  uaEnabled: z.boolean().default(true),
  /** 应用到每条出站请求的 User-Agent 字符串。 */
  userAgent: z.string().default(DEFAULT_UA),
  // ── 网络代理 ──
  /** 代理总开关：关闭时直连（NO_PROXY 判定不生效）。 */
  proxyEnabled: z.boolean().default(false),
  /** 代理协议：http（HTTP CONNECT 隧道）/ socks5。 */
  proxyProtocol: z.string().default('http'),
  /** 代理地址。 */
  proxyHost: z.string().default('127.0.0.1'),
  /** 代理端口。 */
  proxyPort: z.number().default(7890),
  /** 代理用户名（可选）。 */
  proxyUsername: z.string().default(''),
  /** 代理密码（可选）。 */
  proxyPassword: z.string().default(''),
  /** NO_PROXY：命中则直连，默认排除本地回环。 */
  proxyNoProxy: z.array(z.string()).default(DEFAULT_NO_PROXY),
  /** 代理请求超时（ms），默认 60000。 */
  proxyTimeoutMs: z.number().default(60000),
  // ── 请求重试 ──
  /** 自动重试总开关：关闭时所有请求单次尝试。 */
  retryEnabled: z.boolean().default(true),
  /** 最大请求重试次数（0 = 不重试；网络错误或 429/5xx 时自动重试）。 */
  maxRetries: z.number().default(2),
});

/** 推断出的插件配置类型。 */
export type PluginConfig = typeof Config extends z<infer T> ? T : never;

/** 把 fetch input 归一化成字符串 URL（供 NO_PROXY 判定等使用）。 */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null) {
    const url = (input as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return String(input);
}

/**
 * 迁移：读取旧 dsh-net-proxy 的 `net-proxy.json`，把其中的代理字段并入 base。
 * 仅作兜底层 —— 用户通过 config-api 保存的值永远优先。
 */
export function legacyProxyMerge(entry: PluginConfig): PluginConfig {
  try {
    // 只有旧配置文件真实存在时才迁移（loadConfig 缺文件会返回默认值，
    // 不能把默认值当作已保存配置覆盖 entry）。
    if (!existsSync(configPath())) return entry;
    const legacy = loadConfig(configPath());
    if (legacy === null || typeof legacy !== 'object') return entry;
    const record = legacy as Record<string, unknown>;
    return {
      ...entry,
      proxyEnabled: record.enabled === true ? true : entry.proxyEnabled,
      proxyProtocol: typeof record.protocol === 'string' && record.protocol ? record.protocol : entry.proxyProtocol,
      proxyHost: typeof record.host === 'string' && record.host ? record.host : entry.proxyHost,
      proxyPort: record.port != null && Number.isFinite(Number(record.port)) ? Number(record.port) : entry.proxyPort,
      proxyUsername: typeof record.username === 'string' ? record.username : entry.proxyUsername,
      proxyPassword: typeof record.password === 'string' ? record.password : entry.proxyPassword,
      proxyNoProxy: Array.isArray(record.noProxy) && record.noProxy.length ? (record.noProxy as string[]) : entry.proxyNoProxy,
    };
  } catch {
    return entry;
  }
}

/**
 * cordis 服务依赖：`dshLoader` 由 @dsh-plugin/dsh-loader 提供。
 *
 * 声明它让本插件与 dsh 内部面彻底解耦——settings 服务、webServer 路由形状、
 * 全局 fetch 的补丁协议全部经 loader 的稳定门面访问，dsh 改内部时只升级 loader。
 */
export const inject = ['dshLoader'];

/** 插件入口。 */
export async function apply(ctx: Context, injected: PluginConfig): Promise<void> {
  const loader = ctx.dshLoader;
  const base = legacyProxyMerge(Config(injected));
  const config = await loader.config.register<PluginConfig>(ctx, createConfigTemplate(base));
  const current = () => config.get().value;

  if (typeof fetch !== 'function') {
    ctx.logger.warn('[dsh-network-settings] globalThis.fetch 不可用；网络设置失效');
    return;
  }

  /**
   * 组装「重试 → UA → 代理 → 原始 fetch」四层栈。
   *
   * `original` 由 loader 的补丁协议给出：它保证拿到的是安装时刻槽里的真实值，
   * 因此重复 apply（HMR / 配置更新）不会把上一层 wrapper 当成原值再包一层。
   */
  const buildStack = (original: FetchType): FetchType => {
    // 内层：UA 改写 + 代理（每次调用读取最新策略，改设置下一条请求即生效）。
    const inner: FetchType = (input, init) => {
      const cfg = current();
      let detached = init;
      if (shouldRewriteUA(cfg)) {
        detached = applyUserAgent(init, cfg.userAgent.trim());
      }
      const proxyEnabled = cfg.proxyEnabled === true;
      if (proxyEnabled) {
        const proxy = {
          ...toProxy({
            protocol: cfg.proxyProtocol,
            host: cfg.proxyHost,
            port: cfg.proxyPort,
            username: cfg.proxyUsername,
            password: cfg.proxyPassword,
            noProxy: cfg.proxyNoProxy,
          }),
          timeout: cfg.proxyTimeoutMs,
        };
        return proxiedFetch(urlOf(input), detached ?? {}, proxy, original);
      }
      return original(input, detached);
    };

    // 外层：请求自动重试（最大重试次数）。
    return (input, init) => {
      const cfg = current();
      const maxRetries = cfg.retryEnabled === true ? Math.max(0, Math.floor(cfg.maxRetries || 0)) : 0;
      return fetchWithRetry(input, init, inner, {
        maxRetries,
        onRetry: (attempt, info) => {
          const reason = info.status !== undefined ? `HTTP ${info.status}` : String((info.error as Error | undefined)?.message ?? info.error);
          ctx.logger.info(`[dsh-network-settings] 自动重试 ${attempt}/${maxRetries}（${reason}），${info.delayMs}ms 后重发`);
        },
      });
    };
  };

  // 接管全局 fetch。原先此处有约 50 行标记簿记（__dshNetworkSettingsOriginalFetch
  // 全局键、原值/wrapper 配对、还原前身份比对）；这些语义现在由 loader 的补丁协议
  // 统一提供，且它的实现有测试锁定，插件只需声明「怎么包」。
  ctx.effect(() => {
    const handle = loader.patch.global<FetchType>('fetch', buildStack, {
      id: 'dsh-network-settings:fetch', owner: ctx,
    });
    return () => handle.dispose();
  }, 'dsh-network-settings: fetch network stack');

  // Diagnostics use the saved configuration; config writes belong to loader.
  if (loader.services.get('webServer') || loader.services.get('httpServer')) {
    ctx.effect(() => loader.web.exact('/_dsh/dsh-network-settings/probe', (req: any, res: any) => {
      const connection = loader.services.get('connection') as { authorizeIndex?(req: unknown, res: unknown): boolean } | undefined;
      if (!connection?.authorizeIndex) { res.writeHead(503); res.end(); return; }
      if (!connection.authorizeIndex(req, res)) return;
      const origin = req.headers?.origin;
      if (req.headers?.['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
        res.writeHead(403); res.end(); return;
      }
      probeRoute(req, res, current);
    }), 'dsh-network-settings: probe route');
  }

  const cfg = current();
  ctx.logger.info(
    `[dsh-network-settings] 已加载（UA=${cfg.uaEnabled === true}, proxy=${cfg.proxyEnabled === true} ` +
    `${cfg.proxyEnabled === true ? `${cfg.proxyProtocol}://${cfg.proxyHost}:${cfg.proxyPort}` : ''}, ` +
    `retry=${cfg.retryEnabled === true ? cfg.maxRetries : 0}）`,
  );
}

/**
 * 同源探测路由 handler（GET 探活 / POST 携带可选 proxy 覆盖执行连通探测）。
 * 探测只测不改：不会写入任何配置。
 */
export function probeRoute(
  req: {
    method?: string;
    on(event: 'data' | 'end', cb: (chunk?: string) => void): unknown;
  },
  res: {
    writeHead(code: number, headers?: Record<string, string>): unknown;
    end(body?: string): unknown;
  },
  getConfig: () => PluginConfig,
): void {
  const send = (code: number, obj: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET') {
    send(200, { ok: true });
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk ?? '';
    });
    req.on('end', () => {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(body || '{}') as Record<string, unknown>;
      } catch {
        send(400, { ok: false, error: 'invalid json' });
        return;
      }
      const cfg = getConfig();
      const p = (payload && typeof payload.proxy === 'object' && payload.proxy !== null
        ? (payload.proxy as Record<string, unknown>)
        : {});
      const proxy = {
        ...toProxy({
          protocol: typeof p.protocol === 'string' && p.protocol ? p.protocol : cfg.proxyProtocol,
          host: typeof p.host === 'string' && p.host ? p.host : cfg.proxyHost,
          port: p.port != null && Number.isFinite(Number(p.port)) ? Number(p.port) : cfg.proxyPort,
          username: typeof p.username === 'string' ? p.username : cfg.proxyUsername,
          password: typeof p.password === 'string' ? p.password : cfg.proxyPassword,
          noProxy: cfg.proxyNoProxy,
        }),
        timeout: cfg.proxyTimeoutMs,
      };
      Promise.resolve(probeProxy(proxy)).then(
        (result) => send(200, result),
        (error: unknown) => send(200, { ok: false, error: String((error as Error | undefined)?.message ?? error) }),
      );
    });
    return;
  }
  send(405, { ok: false, error: 'method not allowed' });
}
