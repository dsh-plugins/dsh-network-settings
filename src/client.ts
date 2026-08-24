/**
 * @dsh-plugin/dsh-network-settings — BROWSER half.
 *
 * 注册「网络设置」设置标签页（`settings.section` 槽）。标签页分三块，各自
 * 独立保存（与 Host 半边共享 `dsh-network-settings` 命名空间）：
 *
 *   1. UA 设置（uaEnabled / userAgent）
 *   2. 网络代理（proxyEnabled / protocol / host / port / username / password /
 *      NO_PROXY / 超时），含「测试连接」—— 通过同源路由
 *      `/_dsh/dsh-network-settings/probe` 触发 Host 端连通 + 延迟探测
 *   3. 请求重试（retryEnabled / maxRetries）
 *
 * 读写走同源路由 `/_dsh/dsh-network-settings/settings`（Host 半边直通
 * dsh-settings 服务：apiproxy 的配置客户端白名单不含插件自注册命名空间，
 * 浏览器直连 `api.settings.*` 会被 settings-not-exposed 拒绝），Host 半边在
 * 下一条请求即生效。
 *
 * 控件全部来自 @dsh-plugin/dsh-loader 的基础控件库，因此本文件不再维护任何
 * 内联样式对象（迁移前有 33 个）与自建下拉：配色/间距/圆角/深色模式/减少动效
 * 由 loader 的设计令牌统一负责，全家桶插件外观一致。
 *
 * 本模块通过 web profile 的 `__ModuleLoader__` 协议注册；`require` 由 loader
 * 提供而非 Node。注册包在 IIFE 内是刻意的：web profile 里每个 bundle 都以
 * 经典脚本共享 window 全局作用域执行，顶层 `const loader` 会与兄弟 bundle
 * 撞名（后注册者报 SyntaxError 而整体失效），因此沿用 auxiliary /
 * thought-buddy 同款 no-global 模式。
 */

/** 浏览器模块加载器声明形状。 */
interface LoaderDeclaration {
  id: string;
  factory(require: (id: string) => any): unknown;
}

(() => {
  const loader = (
    window as unknown as { __ModuleLoader__: { load(declaration: LoaderDeclaration): void } }
  ).__ModuleLoader__;

  loader.load({
    id: '@dsh-plugin/dsh-network-settings',
    factory: (require) => {
      const React = require('react') as typeof import('react');

      /**
       * dsh-loader 的基础控件与图标。
       *
       * 取 `@dsh-plugin/dsh-loader/client` 而非某个 `/ui` 子路径：DSH 客户端模块表
       * 在查表前只做一件归一化——剥掉 `/client` 后缀（dsh-client-modules 的
       * stripClientSuffix），于是这个 specifier 直接命中 dsh-loader 已注册的工厂并
       * 递归物化，顺序安全且不需要任何别名。换成 `/ui` 则要等 dsh-loader 先物化注册
       * 别名，存在竞态。
       */
      const ui = require('@dsh-plugin/dsh-loader/client') as typeof import('@dsh-plugin/dsh-loader/client');
      const { Button, Card, Checkbox, Col, Field, MenuSelect, Row, Spinner, TextInput, Textarea, T } = ui;

      /** 本插件拥有的 settings 命名空间（与 Host 半边一致）。 */
      const NS = 'dsh-network-settings';
      /** 同源探测路由（Host 半边注册）。 */
      const PROBE_API = '/_dsh/dsh-network-settings/probe';
      /** 同源 settings 读写路由（Host 半边注册）。 */
      const SETTINGS_API = '/_dsh/dsh-network-settings/settings';

      /** 协议下拉选项集。 */
      const PROTOCOL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
        { value: 'http', label: 'HTTP (CONNECT 隧道)' },
        { value: 'socks5', label: 'SOCKS5' },
      ];

      /** 命名空间默认值（与 Host `Config` 对齐，命名空间为空时展示）。 */
      const DEFAULTS = {
        uaEnabled: true,
        userAgent: 'DeepSeek-Harness/0.1 (+https://github.com/deepseek-ai/dsh)',
        proxyEnabled: false,
        proxyProtocol: 'http',
        proxyHost: '127.0.0.1',
        proxyPort: 7890,
        proxyUsername: '',
        proxyPassword: '',
        proxyNoProxy: ['127.0.0.1', 'localhost', '::1'],
        proxyTimeoutMs: 60000,
        retryEnabled: true,
        maxRetries: 2,
      } as const;

      /** describe 返回的命名空间视图值。 */
      interface NamespaceValue {
        uaEnabled?: boolean;
        userAgent?: string;
        proxyEnabled?: boolean;
        proxyProtocol?: string;
        proxyHost?: string;
        proxyPort?: number;
        proxyUsername?: string;
        proxyPassword?: string;
        proxyNoProxy?: string[];
        proxyTimeoutMs?: number;
        retryEnabled?: boolean;
        maxRetries?: number;
      }

      // ── 同源 settings 路由（读写命名空间，绕过 apiproxy 配置客户端白名单）──

      interface RouteOk {
        ok: true;
        revision?: number;
        value?: NamespaceValue;
        writable?: boolean;
      }
      interface RouteError {
        ok: false;
        code?: string;
        error?: string;
      }
      type RouteResponse = RouteOk | RouteError;

      /** GET 读取命名空间：返回解析值 + revision + writable。 */
      async function loadNamespace(): Promise<{
        value: NamespaceValue;
        revision: number;
        writable: boolean;
      }> {
        const response = await fetch(SETTINGS_API, { method: 'GET' });
        const json: RouteResponse = await response.json();
        if (json.ok !== true) {
          throw new Error((json as RouteError).error ?? '读取网络设置失败');
        }
        return {
          value: json.value ?? {},
          revision: json.revision ?? 0,
          writable: json.writable !== false,
        };
      }

      /**
       * 保存一块设置（patch 只含本块字段），成功后刷新 revision。
       * 失败抛错（冲突时 code 为 settings-conflict）。
       */
      async function saveSection(
        patch: Record<string, unknown>,
        expectedRevision: number,
        onRevision: (revision: number) => void,
      ): Promise<void> {
        const response = await fetch(SETTINGS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'update',
            patch,
            expectedRevision: expectedRevision || undefined,
          }),
        });
        const json: RouteResponse = await response.json();
        if (json.ok !== true) {
          const failure = json as RouteError;
          if (failure.code === 'settings-conflict') {
            const error = new Error('conflict') as Error & { code?: string };
            error.code = 'settings-conflict';
            throw error;
          }
          throw new Error(failure.error ?? '保存网络设置失败');
        }
        onRevision(json.revision ?? 0);
      }

      /** 三块卡片共用的 props。 */
      interface CardProps {
        initial: NamespaceValue;
        revision: number;
        writable: boolean;
        onRevision: (revision: number) => void;
      }

      /**
       * 一块设置的保存状态机。
       *
       * 三张卡片的保存流程完全同构（置忙 → 清状态 → 提交 patch → 成功标记 /
       * 失败分类），迁移时抽成 hook，省掉三份重复的 busy/saved/error 三元组。
       */
      function useSaver(props: CardProps) {
        const [busy, setBusy] = React.useState(false);
        const [saved, setSaved] = React.useState(false);
        const [error, setError] = React.useState<string | null>(null);

        /** 任一输入改动都让「已保存」提示失效。 */
        const touch = React.useCallback(() => setSaved(false), []);

        const commit = React.useCallback(
          async (patch: Record<string, unknown>): Promise<void> => {
            setBusy(true);
            setError(null);
            setSaved(false);
            try {
              await saveSection(patch, props.revision, props.onRevision);
              setSaved(true);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              setError(
                /conflict/i.test(message)
                  ? '设置已在其它窗口或进程中被修改，请重新保存。'
                  : `保存失败：${message}`,
              );
              setSaved(false);
            } finally {
              setBusy(false);
            }
          },
          [props.revision, props.onRevision],
        );

        return { busy, saved, error, setError, touch, commit };
      }

      /** 卡片底部的保存按钮 + 状态行（状态行常占位，避免保存时布局跳动）。 */
      function SaveRow(props: {
        busy: boolean;
        writable: boolean;
        saved: boolean;
        error: string | null;
        onSave: () => void;
        extra?: React.ReactElement | null;
      }): React.ReactElement {
        return React.createElement(Col, null, [
          React.createElement(Row, { key: 'actions' }, [
            React.createElement(
              Button,
              {
                key: 'save',
                variant: 'primary',
                loading: props.busy,
                disabled: !props.writable,
                onClick: props.onSave,
              },
              props.busy ? '保存中…' : '保存',
            ),
            props.extra ?? null,
          ]),
          React.createElement(
            'span',
            {
              key: 'status',
              role: props.error === null ? undefined : 'alert',
              style: {
                fontSize: 12,
                minHeight: 18,
                lineHeight: '18px',
                color: props.error !== null ? T.danger : props.saved ? T.accent : 'transparent',
              },
            },
            props.error ?? (props.saved ? '已保存，已应用到后续请求。' : ''),
          ),
        ]);
      }

      /** 卡片 1：UA 设置。 */
      function UaCard(props: CardProps): React.ReactElement {
        const [enabled, setEnabled] = React.useState(props.initial.uaEnabled !== false);
        const [userAgent, setUserAgent] = React.useState(
          typeof props.initial.userAgent === 'string' && props.initial.userAgent.length > 0
            ? props.initial.userAgent
            : DEFAULTS.userAgent,
        );
        const { busy, saved, error, setError, touch, commit } = useSaver(props);

        const save = (): void => {
          if (userAgent.trim().length === 0) {
            setError('User-Agent 不能为空。');
            return;
          }
          void commit({ uaEnabled: enabled, userAgent: userAgent.trim() });
        };

        return React.createElement(Card, { title: 'User-Agent 设置' }, [
          React.createElement(Checkbox, {
            key: 'enabled',
            checked: enabled,
            disabled: !props.writable,
            label: '启用 User-Agent 改写',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setEnabled(event.target.checked);
              touch();
            },
          }),
          React.createElement(
            Field,
            {
              key: 'ua',
              label: 'User-Agent',
              htmlFor: 'dns-ua-value',
              description:
                '对 dsh 的所有出站请求（LLM API 调用等）强制该 User-Agent；关闭开关则原样透传。',
            },
            React.createElement(Textarea, {
              id: 'dns-ua-value',
              mono: true,
              rows: 3,
              spellCheck: false,
              value: userAgent,
              disabled: !props.writable || !enabled,
              onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
                setUserAgent(event.target.value);
                touch();
              },
            }),
          ),
          React.createElement(SaveRow, {
            key: 'save',
            busy,
            writable: props.writable,
            saved,
            error,
            onSave: save,
          }),
        ]);
      }

      /** 卡片 2：网络代理（含连通探测）。 */
      function ProxyCard(props: CardProps): React.ReactElement {
        const [enabled, setEnabled] = React.useState(props.initial.proxyEnabled === true);
        const [protocol, setProtocol] = React.useState(
          props.initial.proxyProtocol === 'socks5' ? 'socks5' : 'http',
        );
        const [host, setHost] = React.useState(
          typeof props.initial.proxyHost === 'string' && props.initial.proxyHost
            ? props.initial.proxyHost
            : DEFAULTS.proxyHost,
        );
        const [port, setPort] = React.useState(
          props.initial.proxyPort != null && Number.isFinite(props.initial.proxyPort)
            ? String(props.initial.proxyPort)
            : String(DEFAULTS.proxyPort),
        );
        const [username, setUsername] = React.useState(props.initial.proxyUsername ?? '');
        const [password, setPassword] = React.useState(props.initial.proxyPassword ?? '');
        const [noProxy, setNoProxy] = React.useState(
          Array.isArray(props.initial.proxyNoProxy) && props.initial.proxyNoProxy.length
            ? props.initial.proxyNoProxy.join(',')
            : DEFAULTS.proxyNoProxy.join(','),
        );
        const { busy, saved, error, touch, commit } = useSaver(props);
        const [probe, setProbe] = React.useState<{ running: boolean; res: Record<string, unknown> | null }>({
          running: false,
          res: null,
        });

        const portNumber = (): number =>
          /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : DEFAULTS.proxyPort;
        const noProxyList = (): string[] => noProxy.split(',').map((s) => s.trim()).filter(Boolean);

        const save = (): void => {
          void commit({
            proxyEnabled: enabled,
            proxyProtocol: protocol,
            proxyHost: host.trim() || DEFAULTS.proxyHost,
            proxyPort: portNumber(),
            proxyUsername: username.trim(),
            proxyPassword: password,
            proxyNoProxy: noProxyList().length ? noProxyList() : DEFAULTS.proxyNoProxy,
          });
        };

        const testNow = async (): Promise<void> => {
          setProbe({ running: true, res: null });
          const body = {
            proxy: {
              protocol,
              host: host.trim() || DEFAULTS.proxyHost,
              port: portNumber(),
              username: username.trim(),
              password,
              noProxy: noProxyList(),
            },
          };
          try {
            const response = await fetch(PROBE_API, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const json: Record<string, unknown> = await response.json();
            setProbe({ running: false, res: json ?? { ok: false, error: 'no response' } });
          } catch {
            setProbe({ running: false, res: { ok: false, error: 'network error' } });
          }
        };

        const probeResult = probe.res as
          | { ok?: boolean; error?: string; connectMs?: number; totalMs?: number; httpStatus?: number }
          | null;

        /** 一个探测指标格。 */
        const stat = (key: string, value: string, label: string): React.ReactElement =>
          React.createElement('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
            React.createElement(
              'span',
              { key: 'v', style: { fontSize: 15, fontWeight: 600, color: T.labelPrimary } },
              value,
            ),
            React.createElement('span', { key: 'l', style: { fontSize: 11, color: T.labelTertiary } }, label),
          ]);

        const locked = !props.writable || !enabled;

        return React.createElement(Card, { title: '网络代理' }, [
          React.createElement(Checkbox, {
            key: 'enabled',
            checked: enabled,
            disabled: !props.writable,
            label: '启用代理（关闭则直连，NO_PROXY 判定也不生效）',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setEnabled(event.target.checked);
              touch();
            },
          }),
          React.createElement(
            'div',
            {
              key: 'grid',
              style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 },
            },
            [
              React.createElement(
                Field,
                { key: 'protocol', label: '协议', htmlFor: 'dns-proxy-protocol' },
                React.createElement(MenuSelect, {
                  id: 'dns-proxy-protocol',
                  label: '协议',
                  options: PROTOCOL_OPTIONS,
                  value: protocol,
                  disabled: locked,
                  onChange: (value: string) => {
                    setProtocol(value === 'socks5' ? 'socks5' : 'http');
                    touch();
                  },
                }),
              ),
              React.createElement(
                Field,
                { key: 'host', label: '代理地址', htmlFor: 'dns-proxy-host' },
                React.createElement(TextInput, {
                  id: 'dns-proxy-host',
                  mono: true,
                  spellCheck: false,
                  placeholder: '如 127.0.0.1',
                  value: host,
                  disabled: locked,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setHost(event.target.value);
                    touch();
                  },
                }),
              ),
              React.createElement(
                Field,
                { key: 'port', label: '端口', htmlFor: 'dns-proxy-port' },
                React.createElement(TextInput, {
                  id: 'dns-proxy-port',
                  mono: true,
                  inputMode: 'numeric',
                  spellCheck: false,
                  placeholder: '如 7890',
                  value: port,
                  disabled: locked,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setPort(event.target.value);
                    touch();
                  },
                }),
              ),
              React.createElement(
                Field,
                { key: 'username', label: '用户名（可选）', htmlFor: 'dns-proxy-username' },
                React.createElement(TextInput, {
                  id: 'dns-proxy-username',
                  spellCheck: false,
                  value: username,
                  disabled: locked,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setUsername(event.target.value);
                    touch();
                  },
                }),
              ),
              React.createElement(
                Field,
                { key: 'password', label: '密码（可选）', htmlFor: 'dns-proxy-password' },
                React.createElement(TextInput, {
                  id: 'dns-proxy-password',
                  type: 'password',
                  value: password,
                  disabled: locked,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setPassword(event.target.value);
                    touch();
                  },
                }),
              ),
              React.createElement(
                'div',
                { key: 'noproxy', style: { gridColumn: '1 / -1' } },
                React.createElement(
                  Field,
                  {
                    label: 'NO_PROXY',
                    htmlFor: 'dns-proxy-noproxy',
                    description: '逗号分隔的 host；命中则直连，不经代理。默认排除本地回环。',
                  },
                  React.createElement(TextInput, {
                    id: 'dns-proxy-noproxy',
                    spellCheck: false,
                    value: noProxy,
                    disabled: locked,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                      setNoProxy(event.target.value);
                      touch();
                    },
                  }),
                ),
              ),
            ],
          ),
          React.createElement(SaveRow, {
            key: 'save',
            busy,
            writable: props.writable,
            saved,
            error,
            onSave: save,
            extra: React.createElement(
              Button,
              {
                key: 'probe',
                variant: 'ghost',
                loading: probe.running,
                disabled: busy || !props.writable,
                onClick: () => void testNow(),
              },
              probe.running ? '测试中…' : '测试连接',
            ),
          }),
          probeResult === null
            ? null
            : React.createElement('div', { key: 'probe', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
                React.createElement(
                  'div',
                  {
                    key: 'alert',
                    role: 'status',
                    style: {
                      fontSize: 12,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: `1px solid ${probeResult.ok === true ? T.accent : T.danger}`,
                      color: probeResult.ok === true ? T.labelPrimary : T.danger,
                    },
                  },
                  probeResult.ok === true
                    ? '代理连通正常'
                    : `代理不可用${typeof probeResult.error === 'string' ? `：${probeResult.error}` : ''}`,
                ),
                probeResult.ok === true
                  ? React.createElement('div', { key: 'stats', style: { display: 'flex', gap: 24 } }, [
                      stat('tcp', `${probeResult.connectMs ?? '—'} ms`, '代理 TCP'),
                      stat('total', `${probeResult.totalMs ?? '—'} ms`, '总延迟（经代理）'),
                      stat('status', String(probeResult.httpStatus ?? '—'), '目标状态'),
                    ])
                  : null,
              ]),
        ]);
      }

      /** 卡片 3：请求重试。 */
      function RetryCard(props: CardProps): React.ReactElement {
        const [enabled, setEnabled] = React.useState(props.initial.retryEnabled !== false);
        const [maxRetries, setMaxRetries] = React.useState(
          props.initial.maxRetries != null && Number.isFinite(props.initial.maxRetries)
            ? String(Math.max(0, Math.min(20, Math.floor(props.initial.maxRetries))))
            : String(DEFAULTS.maxRetries),
        );
        const { busy, saved, error, touch, commit } = useSaver(props);

        const save = (): void => {
          const parsed = Math.max(0, Math.min(20, Math.floor(Number(maxRetries) || 0)));
          void commit({ retryEnabled: enabled, maxRetries: parsed });
        };

        return React.createElement(Card, { title: '请求重试' }, [
          React.createElement(Checkbox, {
            key: 'enabled',
            checked: enabled,
            disabled: !props.writable,
            label: '启用自动重试',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setEnabled(event.target.checked);
              touch();
            },
          }),
          React.createElement(
            Field,
            {
              key: 'count',
              label: '最大请求重试次数',
              htmlFor: 'dns-retry-count',
              description:
                '对 dsh 所有出站请求（LLM API 调用、web 搜索 / 抓取、外部 API 等）在网络错误或 429 / 5xx 时自动重试，至多该次数；0 = 不重试。退避：500ms 起、指数递增、上限 10s。',
            },
            React.createElement(
              'div',
              { style: { maxWidth: 120 } },
              React.createElement(TextInput, {
                id: 'dns-retry-count',
                type: 'number',
                min: 0,
                max: 20,
                step: 1,
                mono: true,
                value: maxRetries,
                disabled: !props.writable || !enabled,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  setMaxRetries(event.target.value);
                  touch();
                },
              }),
            ),
          ),
          React.createElement(SaveRow, {
            key: 'save',
            busy,
            writable: props.writable,
            saved,
            error,
            onSave: save,
          }),
        ]);
      }

      /** 「网络设置」标签页主体：加载一次命名空间，分发给三块卡片。 */
      function NetworkSettingsSection(): React.ReactElement {
        const [ready, setReady] = React.useState(false);
        const [writable, setWritable] = React.useState(true);
        const [revision, setRevision] = React.useState(0);
        const [initial, setInitial] = React.useState<NamespaceValue | null>(null);

        React.useEffect(() => {
          let cancelled = false;
          void (async () => {
            try {
              const loaded = await loadNamespace();
              if (cancelled) return;
              setInitial(loaded.value);
              setRevision(loaded.revision);
              setWritable(loaded.writable);
            } catch {
              if (cancelled) return;
              setWritable(false);
            } finally {
              if (!cancelled) setReady(true);
            }
          })();
          return () => {
            cancelled = true;
          };
        }, []);

        if (!ready) {
          return React.createElement(
            Row,
            null,
            React.createElement(Spinner, { key: 's' }),
            React.createElement('span', { key: 't', style: { fontSize: 12, color: T.labelTertiary } }, '正在读取网络设置…'),
          );
        }

        const shared = { initial: initial ?? {}, revision, writable, onRevision: setRevision };

        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 640 } }, [
          React.createElement(
            'p',
            { key: 'lead', style: { fontSize: 12, lineHeight: 1.6, color: T.labelTertiary, margin: 0 } },
            '统一配置 dsh 的出站网络行为：User-Agent 改写、HTTP/CONNECT/SOCKS5 代理与请求自动重试。改动在保存后对下一条请求立即生效；三块设置互不影响，可分别保存。',
          ),
          React.createElement(UaCard, { key: 'ua', ...shared }),
          React.createElement(ProxyCard, { key: 'proxy', ...shared }),
          React.createElement(RetryCard, { key: 'retry', ...shared }),
          writable
            ? null
            : React.createElement(
                'p',
                { key: 'ro', style: { fontSize: 12, color: T.labelTertiary, margin: 0 } },
                '当前设置为只读，无法保存。',
              ),
        ]);
      }

      const plugin = {
        name: '@dsh-plugin/dsh-network-settings',
        inject: ['slots'],
        apply(ctx: { get<T = unknown>(service: string): T | undefined }): void {
          const slots = ctx.get<{
            inject(name: string, callback: () => unknown): unknown;
            register(options: unknown, component: unknown): unknown;
          }>('slots');
          if (slots === undefined) {
            return;
          }
          slots.inject('settings.section', () =>
            slots.register(
              {
                name: 'settings.section',
                id: NS,
                order: 30,
                label: () => '网络设置',
                inject: () => ({}),
              },
              NetworkSettingsSection,
            ),
          );
        },
      };

      return plugin;
    },
  });
})();
