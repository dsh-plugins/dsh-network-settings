/**
 * @dsh-plugin/dsh-network-settings — HOST half.
 *
 * 一个插件集成三块网络能力，全部由「网络设置」命名空间（dsh-settings）驱动：
 *
 *   1. User-Agent 改写（移植自 @dsh-plugin/dsh-user-agent）
 *      对每条出站请求强制写入配置的 `User-Agent`。
 *   2. HTTP / HTTPS-CONNECT / SOCKS5 代理（移植自 dsh-net-proxy）
 *      把 agent 的网络请求（LLM API 调用、web 搜索 / 抓取、外部 API）经代理
 *      发出，支持 NO_PROXY 直连判定、凭据、超时，并在同源路由
 *      `/_dsh/dsh-network-settings/probe` 暴露连通/延迟探测。
 *   3. 请求自动重试（「最大请求重试次数」）
 *      对网络层错误或可重试状态码（429 / 5xx）自动重试至多 maxRetries 次，
 *      有界指数退避 + 抖动。
 *
 * 三层按「重试 → UA → 代理 → 原始 fetch」叠放：每一次请求尝试都会重新读取
 * 最新的命名空间解析值并应用全部策略（改设置后下一条请求即生效）。
 *
 * 配置来源
 * --------
 * - 命名空间 `dsh-network-settings`（schema 见 `Config`）。`installSettingsSection`
 *   把组合入口（base 层）与解析后的 settings 作用域桥接为权威 `current()`：
 *   有 settings 服务时返回解析作用域，否则回退到入口，插件始终可用。
 * - 兼容迁移：若 `~/.dsh/net-proxy.json`（旧 dsh-net-proxy 的配置文件）存在，
 *   其字段并入 base 层（用户已保存的命名空间值仍然优先），实现无痛升级。
 *
 * 生命周期
 * --------
 * - 全局 fetch 只被包装一次（`__dshNetworkSettingsOriginalFetch` 标记），
 *   插件停止 / 更新 / 卸载时恢复原始 fetch（`ctx.effect` disposer）。
 * - 每一次包装均在 effect 内注册，运行期可安全热更。
 */
import type { Context } from '@deepseek-ai/cordis';
import { existsSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
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

/** 稳定命名空间 id（仅允许 [a-z0-9-]，保持稳定以保留已保存的用户设置）。 */
export const PLUGIN_ID = 'dsh-network-settings';

const NS = settingsNamespace(PLUGIN_ID);

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

/** webServer 服务最小视图（dsh-host-webserver 无 TS 声明，本地建模）。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: {
      method?: string;
      on(event: 'data' | 'end', cb: (chunk?: string) => void): unknown;
    }, res: {
      writeHead(code: number, headers?: Record<string, string>): unknown;
      end(body?: string): unknown;
    }) => unknown;
  }): () => void;
  registerUpgrade?(route: unknown): () => void;
}

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
 * 仅作兜底层 —— 用户通过命名空间保存的值永远优先。
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

/** 全局标记：跨 apply 周期记住真实原始 fetch。 */
const MARK_KEY = '__dshNetworkSettingsOriginalFetch';

interface MarkerState {
  original: FetchType;
  wrapper: FetchType;
}

/** 插件入口。 */
export function apply(ctx: Context, injected: PluginConfig): void {
  let current: () => PluginConfig = () => injected;
  const base = legacyProxyMerge(injected);

  // 桥接组合入口与用户设置作用域；无 settings 服务时回退到入口。
  installSettingsSection(ctx, NS, Config, base, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
    validate: () => {},
  });

  const g = globalThis as typeof globalThis & Record<string, unknown>;
  const fetchGlobal: FetchType | undefined = typeof fetch === 'function' ? (fetch as FetchType) : undefined;
  if (fetchGlobal === undefined) {
    ctx.logger.warn('[dsh-network-settings] globalThis.fetch 不可用；网络设置失效');
    return;
  }

  // 只在首次捕获真实 fetch；重复 apply（HMR / 更新）复用标记，卸载总能还原基线。
  let marker: MarkerState | undefined = g[MARK_KEY] as MarkerState | undefined;
  const original: FetchType = marker?.original ?? fetchGlobal;

  // 内层：UA 改写 + 代理（每次调用读取最新策略）。
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
  const wrapper: FetchType = (input, init) => {
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

  g.fetch = wrapper;
  if (marker === undefined) {
    marker = { original, wrapper };
    g[MARK_KEY] = marker;
  }

  // 同源探测路由：/_dsh/dsh-network-settings/probe（浏览器「测试连接」用）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const ws = (webCtx as unknown as { webServer?: WebServerLike }).webServer;
      if (ws === undefined) return () => {};
      return ws.register({
        kind: 'exact',
        path: '/_dsh/dsh-network-settings/probe',
        handler: (req, res) => probeRoute(req, res, current),
      });
    }, 'dsh-network-settings: probe route');
  });

  ctx.effect(
    () => () => {
      if (marker !== undefined && g.fetch === marker.wrapper) {
        g.fetch = marker.original;
      }
      if (g[MARK_KEY] === marker) delete g[MARK_KEY];
    },
    'dsh-network-settings: fetch network stack',
  );

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