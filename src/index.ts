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

/** 稳定命名空间 id（仅允许 [a-z0-9-]，保持稳定以保留已保存的用户设置）。 */
export const PLUGIN_ID = 'dsh-network-settings';

/**
 * 本插件拥有的 settings 命名空间句柄。
 *
 * 迁移到 dsh-loader 之后不再直接 import `settingsNamespace`，而是在 `apply` 里
 * 经 `loader.settings.namespace()` 取得；在此之前（以及 dsh-settings 缺席时）退化
 * 为裸 id 字符串——`settingsRoute` 只把它原样交回 settings 服务，两种形态等价。
 */
let NS: unknown = PLUGIN_ID;

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

/**
 * `ctx.dshLoader` 的最小视图（本插件只用到 patch / web / services 三处）。
 *
 * 本地建模而不是从 @dsh-plugin/dsh-loader 导入类型，是为了让宿主半保持
 * 「运行时零 @deepseek-ai 导入、构建期零硬类型耦合」——loader 的真实类型面
 * 在 dsh 升级时可能扩展，插件只声明自己依赖的那一小块。
 */
interface DshLoaderHostApi {
  patch: {
    global<T>(
      key: string,
      wrap: (original: T) => T,
      options?: { id?: string; scope?: object },
    ): { dispose(): void };
  };
  web: {
    exact(path: string, handler: unknown): () => void;
  };
  services: {
    get(name: string): unknown;
  };
  settings: {
    namespace(id: string): unknown;
    installSection<T>(
      ctx: unknown,
      ns: unknown,
      schema: unknown,
      entry: T,
      hooks: { setSource(current: () => T): void; onChange(): void; validate(value: T): void },
    ): boolean;
    isConflictError(error: unknown): boolean;
  };
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

/**
 * cordis 服务依赖：`dshLoader` 由 @dsh-plugin/dsh-loader 提供。
 *
 * 声明它让本插件与 dsh 内部面彻底解耦——settings 服务、webServer 路由形状、
 * 全局 fetch 的补丁协议全部经 loader 的稳定门面访问，dsh 改内部时只升级 loader。
 */
export const inject = ['dshLoader'];

/** 插件入口。 */
export function apply(ctx: Context, injected: PluginConfig): void {
  const loader = (ctx as Context & { dshLoader: DshLoaderHostApi }).dshLoader;
  let current: () => PluginConfig = () => injected;
  const base = legacyProxyMerge(injected);

  NS = loader.settings.namespace(PLUGIN_ID);

  // 桥接组合入口与用户设置作用域；无 settings 服务时回退到入口。
  // 经 loader 门面转发到 dsh 的 installSettingsSection（不重实现其回退语义）。
  loader.settings.installSection<PluginConfig>(ctx, NS, Config, base, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
    validate: () => {},
  });

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
      id: 'dsh-network-settings:fetch',
    });
    return () => handle.dispose();
  }, 'dsh-network-settings: fetch network stack');

  // 同源路由：/_dsh/dsh-network-settings/probe（浏览器「测试连接」用）与
  // /_dsh/dsh-network-settings/settings（浏览器读写本命名空间——apiproxy 的
  // 配置客户端白名单不含插件自注册命名空间，故走 host 侧直通路由）。
  //
  // 经 loader 的 web 门面注册 kind: 'exact'（任意方法，由 handler 自行分派）。
  // headless profile 没有 web 服务，先探测再注册，避免门面抛错中断装配。
  const hasWebServer =
    loader.services.get('webServer') !== undefined || loader.services.get('httpServer') !== undefined;
  if (hasWebServer) {
    ctx.effect(() => {
      const disposers = [
        loader.web.exact('/_dsh/dsh-network-settings/probe', (req: unknown, res: unknown) =>
          probeRoute(req as never, res as never, current),
        ),
        loader.web.exact('/_dsh/dsh-network-settings/settings', (req: unknown, res: unknown) =>
          settingsRoute(
            req as never,
            res as never,
            () => loader.services.get('settings') as SettingsServiceView | undefined,
            loader.settings.isConflictError,
          ),
        ),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-network-settings: probe + settings routes');
  } else {
    ctx.logger.info('[dsh-network-settings] 无 webServer 服务；跳过同源探测/设置路由');
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

/** dsh-settings 服务的最小视图（描述 / 读写 / 可写性），供本插件路由使用。 */
interface SettingsServiceView {
  describe(options?: { redactSecrets?: boolean }): ReadonlyArray<{
    ns: unknown;
    revision?: number;
    value?: unknown;
    base?: unknown;
    user?: unknown;
    secrets?: unknown;
  }>;
  update(ns: unknown, patch: object, expectedRevision?: number): Promise<unknown>;
  replace(ns: unknown, section: object, expectedRevision?: number): Promise<unknown>;
  readonly writable: boolean;
}

/** 浏览器读写本命名空间的同源路由视图（GET 读 / POST 写）。 */
interface SettingsRouteRequest {
  method?: string;
  on(event: 'data' | 'end', cb: (chunk?: string) => void): unknown;
}
interface SettingsRouteResponse {
  writeHead(code: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}

/** 把 settings 服务中的一个命名空间描述符投影为浏览器视图。 */
function settingsView(settings: SettingsServiceView, ns: unknown): Record<string, unknown> {
  const key = String(ns);
  const descriptor = settings.describe({ redactSecrets: true }).find((d) => String(d.ns) === key);
  return {
    ok: true,
    ns: key,
    revision: descriptor?.revision ?? 0,
    value: (descriptor?.value ?? {}) as Record<string, unknown>,
    ...(descriptor?.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor?.user === undefined ? {} : { user: descriptor.user }),
    writable: settings.writable,
  };
}

/**
 * 同源 settings 读写路由：`GET` 读取命名空间视图，`POST` 执行
 * `{mode: 'update'|'replace'}` 写入（支持 `expectedRevision` 冲突防护）。
 *
 * 为什么需要它：dsh-host-apiproxy 的配置客户端白名单不包含插件自注册的
 * 命名空间（上游刻意为之，把暴露决策移交给 `settings.register()` 属 deferred
 * work），浏览器直接走 `api.settings.*` 会被 `settings-not-exposed` 拒绝。
 * 本路由在 host 侧直接调用 dsh-settings 服务，语义与白名单 API 完全一致：
 * revision 冲突（→ 409 settings-conflict）、schema 校验失败（→ 400
 * settings-rejected）、redact 读取。
 *
 * @param isConflict 判定「revision 冲突」的谓词。迁移到 dsh-loader 后不再直接
 *   `instanceof SettingsConflictError`，而由调用方传入 `loader.settings
 *   .isConflictError`；缺省退化为结构判定（带 expected/actual 字段），与 loader
 *   门面自身的兜底一致。
 */
export function settingsRoute(
  req: SettingsRouteRequest,
  res: SettingsRouteResponse,
  getSettings: () => SettingsServiceView | undefined,
  isConflict: (error: unknown) => boolean = (error) =>
    error !== null && typeof error === 'object' && ('expected' in error || 'actual' in error),
): void {
  const send = (code: number, obj: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const settings = getSettings();
  if (settings === undefined) {
    send(500, { ok: false, code: 'settings-absent', error: 'settings service is absent' });
    return;
  }
  if (req.method === 'GET') {
    send(200, settingsView(settings, NS));
    return;
  }
  if (req.method !== 'POST') {
    send(405, { ok: false, code: 'method-not-allowed', error: 'method not allowed' });
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk ?? '';
  });
  req.on('end', () => {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(body || '{}') as Record<string, unknown>;
    } catch {
      send(400, { ok: false, code: 'invalid-json', error: 'invalid json' });
      return;
    }
    const mode = payload.mode === 'replace' ? 'replace' : 'update';
    const expected = payload.expectedRevision;
    const expectedRevision = typeof expected === 'number' && expected > 0 ? expected : undefined;
    let operation: Promise<unknown>;
    if (mode === 'replace') {
      const section = payload.section;
      operation = typeof section === 'object' && section !== null
        ? settings.replace(NS, section as Record<string, unknown>, expectedRevision)
        : Promise.reject(new Error('section 必须是 JSON 对象'));
    } else {
      const patch = payload.patch;
      operation = typeof patch === 'object' && patch !== null
        ? settings.update(NS, patch as Record<string, unknown>, expectedRevision)
        : Promise.reject(new Error('patch 必须是 JSON 对象'));
    }
    Promise.resolve(operation).then(
      () => send(200, settingsView(settings, NS)),
      (error: unknown) => {
        if (isConflict(error)) {
          const conflict = error as { message?: string; expected?: unknown; actual?: unknown };
          send(409, {
            ok: false,
            code: 'settings-conflict',
            error: conflict.message,
            expected: conflict.expected,
            actual: conflict.actual,
          });
          return;
        }
        send(400, {
          ok: false,
          code: 'settings-rejected',
          error: String((error as Error | undefined)?.message ?? error),
        });
      },
    );
  });
}