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
 * 读写走连接层 ApiProxy（`api.settings.describe` / `update`），与
 * dsh-user-agent / dsh-auxiliary 同一条缝，Host 半边在下一条请求即生效。
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
      // 平台 UI 原语（web shell 冻结模块表提供，auxiliary 同款）：Menu 下拉 /
      // 下拉箭头图标。触发器与弹出层样式因此与其他 DSH picker 保持一致。
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as {
        Menu: (props: {
          open: boolean;
          anchor: React.ReactElement;
          items: ReadonlyArray<{ id: string; label: string }>;
          selectedId?: string;
          onSelect?: (id: string) => void;
          onClose?: () => void;
          align?: 'start' | 'center' | 'end';
          side?: 'top' | 'bottom';
          dense?: boolean;
        }) => React.ReactElement;
        IconChevronDownOutline14: (props: { size?: number }) => React.ReactElement;
      };
      const Menu = primitives.Menu;
      const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;

      /** 本插件拥有的 settings 命名空间（与 Host 半边一致）。 */
      const NS = 'dsh-network-settings';
      /** 同源探测路由（Host 半边注册）。 */
      const PROBE_API = '/_dsh/dsh-network-settings/probe';

      /** 协议下拉选项集。 */
      const PROTOCOL_ITEMS = [
        { id: 'http', label: 'HTTP (CONNECT 隧道)' },
        { id: 'socks5', label: 'SOCKS5' },
      ] as const;
      /** 下拉菜单高度上限（与 useMenuHeightLimit 同步）。 */
      const MENU_MAX_HEIGHT = 264;

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

      /** Rpc 信封。 */
      interface RpcResult<T> {
        ok: boolean;
        value?: T;
        error?: { code?: string; message?: string };
      }
      interface RpcResponse<T> {
        result: RpcResult<T>;
      }
      interface NamespaceView {
        ns: string;
        revision: number;
        value?: NamespaceValue;
      }
      interface SettingsDescribeValue {
        namespaces: NamespaceView[];
        writable: boolean;
      }
      /** 设置页需要的 ApiProxy 面。 */
      interface SettingsFacade {
        describe(input: Record<string, never>): Promise<RpcResponse<SettingsDescribeValue>>;
        update(input: {
          ns: string;
          patch: Record<string, unknown>;
          expectedRevision?: number;
        }): Promise<RpcResponse<unknown>>;
      }
      interface IApiClient {
        settings: SettingsFacade;
      }

      /** 解包 RpcResponse，失败即抛。 */
      function unwrap<T>(response: RpcResponse<T>): T {
        if (!response.result.ok) {
          throw new Error(response.result.error?.message ?? 'settings RPC failed');
        }
        return response.result.value as T;
      }

      /** 读取命名空间：返回解析值 + revision + writable。 */
      async function loadNamespace(api: IApiClient): Promise<{
        value: NamespaceValue;
        revision: number;
        writable: boolean;
      }> {
        const describe = await api.settings.describe({});
        const decoded: SettingsDescribeValue | undefined =
          describe.result.ok ? describe.result.value : undefined;
        const ns = (decoded?.namespaces ?? []).find((entry) => entry.ns === NS);
        const value = ns?.value ?? {};
        return {
          value,
          revision: ns?.revision ?? 0,
          writable: decoded?.writable !== false,
        };
      }

      /**
       * 保存一块设置（patch 只含本块字段），成功后刷新 revision。
       * 失败抛错（conflict 时 message 含 conflict）。
       */
      async function saveSection(
        api: IApiClient,
        patch: Record<string, unknown>,
        expectedRevision: number,
        onRevision: (revision: number) => void,
      ): Promise<void> {
        await unwrap(
          await api.settings.update({
            ns: NS,
            patch,
            expectedRevision: expectedRevision || undefined,
          }),
        );
        const after = await loadNamespace(api);
        onRevision(after.revision);
      }

      // ── 内联样式（本包私有，无全局 CSS）──
      const rootStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        maxWidth: 640,
      };
      const leadStyle: React.CSSProperties = {
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-tertiary, #6f6f6f)',
        margin: 0,
      };
      const cardStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 18,
        border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      };
      const cardHeadStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
      };
      const cardTitleStyle: React.CSSProperties = {
        fontSize: 14,
        fontWeight: 600,
        margin: 0,
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      };
      const badgeStyle: React.CSSProperties = {
        whiteSpace: 'nowrap',
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: 11,
        fontWeight: 500,
        background: 'var(--dsw-alias-bg-module-platform, #eff0f1)',
        color: 'var(--dsw-alias-label-secondary, #444)',
      };
      const badgeOkStyle: React.CSSProperties = {
        ...badgeStyle,
        color: 'var(--dsw-alias-state-success-primary, #2e7d32)',
      };
      const fieldStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      };
      const fieldGridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 12,
      };
      const fieldFullStyle: React.CSSProperties = {
        ...fieldStyle,
        gridColumn: '1 / -1',
      };
      const labelStyle: React.CSSProperties = {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      };
      const hintStyle: React.CSSProperties = {
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary, #6f6f6f)',
      };
      const inputStyle: React.CSSProperties = {
        font: 'inherit',
        fontSize: 13,
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
        borderRadius: 8,
        background: 'transparent',
        color: 'inherit',
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
      };
      const monoInputStyle: React.CSSProperties = {
        ...inputStyle,
        fontFamily: 'monospace',
      };
      /** 协议下拉触发器（对齐 dsh-auxiliary 的 ThinkingLevelSelect 触发器）。 */
      const triggerStyle: React.CSSProperties = {
        alignItems: 'center',
        appearance: 'none',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
        borderRadius: 8,
        boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        cursor: 'pointer',
        display: 'flex',
        font: 'inherit',
        fontSize: 14,
        gap: 8,
        justifyContent: 'space-between',
        lineHeight: '20px',
        minHeight: 36,
        padding: '7px 10px',
        textAlign: 'left',
        width: '100%',
      };
      const triggerTextStyle: React.CSSProperties = {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      };
      const switchStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      };
      const actionsStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      };
      const buttonStyle: React.CSSProperties = {
        font: 'inherit',
        fontSize: 13,
        height: 32,
        lineHeight: '22px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 16,
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        cursor: 'pointer',
      };
      const ghostButtonStyle: React.CSSProperties = {
        ...buttonStyle,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
      };
      const statusStyle: React.CSSProperties = {
        fontSize: 12,
        minHeight: 16,
      };
      const probeStatsStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 8,
        fontSize: 12,
      };
      const probeStatStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l2, #eee)',
      };
      const probeStatValueStyle: React.CSSProperties = {
        fontWeight: 600,
        fontSize: 13,
      };
      const probeStatLabelStyle: React.CSSProperties = {
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #6f6f6f)',
      };
      const alertStyle = (ok: boolean): React.CSSProperties => ({
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        lineHeight: 1.5,
        background: ok ? 'rgba(46,125,50,.12)' : 'rgba(198,40,40,.12)',
        color: ok ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'var(--dsw-alias-state-error-primary, #c62828)',
      });

      // ── 三个卡片组件 ──

      interface CardProps {
        api: IApiClient;
        initial: NamespaceValue;
        revision: number;
        writable: boolean;
        onRevision: (revision: number) => void;
      }

      /** 代理协议下拉：平台 Menu 原语（对齐 dsh-auxiliary 的 ThinkingLevelSelect）。 */
      function ProtocolSelect(props: {
        value: 'http' | 'socks5';
        disabled: boolean;
        onChange: (value: 'http' | 'socks5') => void;
      }): React.ReactElement {
        const [open, setOpen] = React.useState(false);
        const [side, setSide] = React.useState<'bottom' | 'top'>('bottom');
        const triggerRef = React.useRef<HTMLButtonElement | null>(null);
        const menuRoot = React.useCallback(() => triggerRef.current?.parentElement ?? null, [triggerRef]);
        const displayValue = props.value === 'socks5' ? 'SOCKS5' : 'HTTP (CONNECT 隧道)';
        const updateSide = React.useCallback((): void => {
          const trigger = triggerRef.current;
          if (trigger === null) return;
          const rect = trigger.getBoundingClientRect();
          const below = window.innerHeight - rect.bottom - 12;
          const above = rect.top - 12;
          setSide(below >= Math.min(MENU_MAX_HEIGHT, above) ? 'bottom' : 'top');
        }, []);
        React.useEffect(() => {
          if (!open) return;
          updateSide();
          window.addEventListener('scroll', updateSide, true);
          window.addEventListener('resize', updateSide);
          return () => {
            window.removeEventListener('scroll', updateSide, true);
            window.removeEventListener('resize', updateSide);
          };
        }, [open, updateSide]);
        // 菜单高度封顶：Menu 原语默认按整视口滚动，小型选项列表改为紧凑内滚
        React.useEffect(() => {
          if (!open) return;
          const frame = window.requestAnimationFrame(() => {
            const menu = menuRoot()?.querySelector<HTMLElement>('[role="menu"]');
            if (menu === undefined || menu === null) return;
            menu.style.maxHeight = `${MENU_MAX_HEIGHT}px`;
            menu.style.overflowY = 'auto';
          });
          return () => window.cancelAnimationFrame(frame);
        }, [open, menuRoot]);
        return React.createElement(
          Menu,
          {
            open,
            anchor: React.createElement(
              'button',
              {
                ref: triggerRef,
                type: 'button',
                disabled: props.disabled,
                'aria-haspopup': 'menu',
                'aria-expanded': open,
                style: { ...triggerStyle, opacity: props.disabled ? 0.45 : 1 },
                onClick: () => setOpen((previous) => !previous),
              },
              [
                React.createElement('span', { key: 'text', style: triggerTextStyle }, displayValue),
                React.createElement(
                  'span',
                  {
                    key: 'chevron',
                    style: {
                      alignItems: 'center',
                      color: 'var(--dsw-alias-label-tertiary, #6f6f6f)',
                      display: 'inline-flex',
                      flexShrink: 0,
                    },
                  },
                  React.createElement(IconChevronDownOutline14, { size: 14 }),
                ),
              ],
            ),
            items: PROTOCOL_ITEMS,
            selectedId: props.value,
            onSelect: (id: string) => {
              if (id === 'http' || id === 'socks5') {
                props.onChange(id);
              }
              setOpen(false);
            },
            onClose: () => setOpen(false),
            align: 'start',
            side,
            dense: true,
          },
        );
      }

      /** 卡片通用：保存按钮 + 状态行。 */
      function SaveActions(props: {
        busy: boolean;
        writable: boolean;
        saved: boolean;
        error: string | null;
        onSave: () => void;
        extra?: React.ReactElement | null;
      }): React.ReactElement {
        return React.createElement(React.Fragment, null, [
          React.createElement(
            'div',
            { key: 'actions', style: actionsStyle },
            [
              React.createElement(
                'button',
                {
                  key: 'save',
                  type: 'button',
                  style: buttonStyle,
                  disabled: props.busy || !props.writable,
                  onClick: props.onSave,
                },
                props.busy ? '保存中…' : '保存',
              ),
              props.extra ?? null,
            ],
          ),
          React.createElement(
            'div',
            {
              key: 'status',
              style: {
                ...statusStyle,
                color: props.error
                  ? 'var(--dsw-alias-state-error-primary, #c62828)'
                  : props.saved
                    ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
                    : 'transparent',
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
        const [busy, setBusy] = React.useState(false);
        const [saved, setSaved] = React.useState(false);
        const [error, setError] = React.useState<string | null>(null);

        const save = async (): Promise<void> => {
          if (userAgent.trim().length === 0) {
            setError('User-Agent 不能为空。');
            setSaved(false);
            return;
          }
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            await saveSection(props.api, { uaEnabled: enabled, userAgent: userAgent.trim() }, props.revision, props.onRevision);
            setSaved(true);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(/conflict/i.test(message) ? '设置已在其它窗口或进程中被修改，请重新保存。' : `保存失败：${message}`);
            setSaved(false);
          } finally {
            setBusy(false);
          }
        };

        return React.createElement('section', { style: cardStyle }, [
          React.createElement('div', { key: 'head', style: cardHeadStyle }, [
            React.createElement('h3', { key: 'title', style: cardTitleStyle }, 'User-Agent 设置'),
            React.createElement('span', { key: 'badge', style: enabled ? badgeOkStyle : badgeStyle }, enabled ? '已启用' : '已关闭'),
          ]),
          React.createElement('div', { key: 'switch', style: switchStyle }, [
            React.createElement('input', {
              key: 'sw-input',
              type: 'checkbox',
              id: 'dns-ua-enabled',
              checked: enabled,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                setEnabled(event.target.checked);
                setSaved(false);
              },
              disabled: !props.writable,
              style: { width: 16, height: 16 },
            }),
            React.createElement('label', { key: 'sw-label', htmlFor: 'dns-ua-enabled' }, '启用 User-Agent 改写'),
          ]),
          React.createElement('div', { key: 'field', style: fieldStyle }, [
            React.createElement('label', { key: 'ua-label', htmlFor: 'dns-ua-value', style: labelStyle }, 'User-Agent'),
            React.createElement('textarea', {
              key: 'ua-input',
              id: 'dns-ua-value',
              value: userAgent,
              onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
                setUserAgent(event.target.value);
                setSaved(false);
              },
              disabled: !props.writable || !enabled,
              rows: 3,
              style: monoInputStyle,
              spellCheck: false,
            }),
            React.createElement(
              'span',
              { key: 'ua-hint', style: hintStyle },
              '对 dsh 的所有出站请求（LLM API 调用等）强制该 User-Agent；关闭开关则原样透传。',
            ),
          ]),
          React.createElement(SaveActions, {
            key: 'actions',
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
        const [busy, setBusy] = React.useState(false);
        const [saved, setSaved] = React.useState(false);
        const [error, setError] = React.useState<string | null>(null);
        const [probe, setProbe] = React.useState<{ running: boolean; res: Record<string, unknown> | null }>({
          running: false,
          res: null,
        });

        const portNumber = (): number =>
          /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : DEFAULTS.proxyPort;
        const noProxyList = (): string[] =>
          noProxy.split(',').map((s) => s.trim()).filter(Boolean);

        const save = async (): Promise<void> => {
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            await saveSection(
              props.api,
              {
                proxyEnabled: enabled,
                proxyProtocol: protocol,
                proxyHost: host.trim() || DEFAULTS.proxyHost,
                proxyPort: portNumber(),
                proxyUsername: username.trim(),
                proxyPassword: password,
                proxyNoProxy: noProxyList().length ? noProxyList() : DEFAULTS.proxyNoProxy,
              },
              props.revision,
              props.onRevision,
            );
            setSaved(true);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(/conflict/i.test(message) ? '设置已在其它窗口或进程中被修改，请重新保存。' : `保存失败：${message}`);
            setSaved(false);
          } finally {
            setBusy(false);
          }
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

        return React.createElement('section', { style: cardStyle }, [
          React.createElement('div', { key: 'head', style: cardHeadStyle }, [
            React.createElement('h3', { key: 'title', style: cardTitleStyle }, '网络代理'),
            React.createElement(
              'span',
              { key: 'badge', style: enabled ? badgeOkStyle : badgeStyle },
              enabled ? '已启用（当前编辑值）' : '已关闭（直连）',
            ),
          ]),
          React.createElement('div', { key: 'switch', style: switchStyle }, [
            React.createElement('input', {
              key: 'sw-input',
              type: 'checkbox',
              id: 'dns-proxy-enabled',
              checked: enabled,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                setEnabled(event.target.checked);
                setSaved(false);
              },
              disabled: !props.writable,
              style: { width: 16, height: 16 },
            }),
            React.createElement('label', { key: 'sw-label', htmlFor: 'dns-proxy-enabled' }, '启用代理'),
          ]),
          React.createElement(
            'div',
            { key: 'form', style: fieldGridStyle },
            [
              React.createElement('div', { key: 'protocol', style: fieldStyle }, [
                React.createElement('label', { key: 'l', style: labelStyle }, '协议'),
                React.createElement(ProtocolSelect, {
                  key: 'i',
                  value: protocol === 'socks5' ? 'socks5' : 'http',
                  disabled: !props.writable || !enabled,
                  onChange: (value: 'http' | 'socks5') => {
                    setProtocol(value);
                    setSaved(false);
                  },
                }),
              ]),
              React.createElement('div', { key: 'host', style: fieldStyle }, [
                React.createElement('label', { key: 'l', htmlFor: 'dns-proxy-host', style: labelStyle }, '代理地址'),
                React.createElement('input', {
                  key: 'i',
                  id: 'dns-proxy-host',
                  type: 'text',
                  value: host,
                  placeholder: '如 127.0.0.1',
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setHost(event.target.value);
                    setSaved(false);
                  },
                  disabled: !props.writable || !enabled,
                  style: monoInputStyle,
                  spellCheck: false,
                }),
              ]),
              React.createElement('div', { key: 'port', style: fieldStyle }, [
                React.createElement('label', { key: 'l', htmlFor: 'dns-proxy-port', style: labelStyle }, '端口'),
                React.createElement('input', {
                  key: 'i',
                  id: 'dns-proxy-port',
                  type: 'text',
                  inputMode: 'numeric',
                  value: port,
                  placeholder: '如 7890',
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setPort(event.target.value);
                    setSaved(false);
                  },
                  disabled: !props.writable || !enabled,
                  style: monoInputStyle,
                  spellCheck: false,
                }),
              ]),
              React.createElement('div', { key: 'username', style: fieldStyle }, [
                React.createElement('label', { key: 'l', htmlFor: 'dns-proxy-username', style: labelStyle }, '用户名（可选）'),
                React.createElement('input', {
                  key: 'i',
                  id: 'dns-proxy-username',
                  type: 'text',
                  value: username,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setUsername(event.target.value);
                    setSaved(false);
                  },
                  disabled: !props.writable || !enabled,
                  style: inputStyle,
                  spellCheck: false,
                }),
              ]),
              React.createElement('div', { key: 'password', style: fieldStyle }, [
                React.createElement('label', { key: 'l', htmlFor: 'dns-proxy-password', style: labelStyle }, '密码（可选）'),
                React.createElement('input', {
                  key: 'i',
                  id: 'dns-proxy-password',
                  type: 'password',
                  value: password,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setPassword(event.target.value);
                    setSaved(false);
                  },
                  disabled: !props.writable || !enabled,
                  style: inputStyle,
                }),
              ]),
              React.createElement('div', { key: 'noproxy', style: fieldFullStyle }, [
                React.createElement('label', { key: 'l', htmlFor: 'dns-proxy-noproxy', style: labelStyle }, 'NO_PROXY'),
                React.createElement('input', {
                  key: 'i',
                  id: 'dns-proxy-noproxy',
                  type: 'text',
                  value: noProxy,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    setNoProxy(event.target.value);
                    setSaved(false);
                  },
                  disabled: !props.writable || !enabled,
                  style: inputStyle,
                  spellCheck: false,
                }),
                React.createElement(
                  'span',
                  { key: 'hint', style: hintStyle },
                  '逗号分隔的 host；命中则直连，不经代理。默认排除本地回环。',
                ),
              ]),
            ],
          ),
          React.createElement(SaveActions, {
            key: 'actions',
            busy,
            writable: props.writable,
            saved,
            error,
            onSave: save,
            extra: React.createElement(
              'button',
              {
                key: 'probe',
                type: 'button',
                style: ghostButtonStyle,
                disabled: probe.running || busy || !props.writable,
                onClick: testNow,
              },
              probe.running ? '测试中…' : '测试连接',
            ),
          }),
          probeResult
            ? React.createElement('div', { key: 'probe-result', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                React.createElement(
                  'div',
                  { key: 'alert', style: alertStyle(probeResult.ok === true) },
                  probeResult.ok === true
                    ? '代理连通正常'
                    : `代理不可用${typeof probeResult.error === 'string' ? `：${probeResult.error}` : ''}`,
                ),
                probeResult.ok === true
                  ? React.createElement('div', { key: 'stats', style: probeStatsStyle }, [
                      React.createElement('div', { key: 'tcp', style: probeStatStyle }, [
                        React.createElement('span', { key: 'v', style: probeStatValueStyle }, `${probeResult.connectMs ?? '—'} ms`),
                        React.createElement('span', { key: 'l', style: probeStatLabelStyle }, '代理 TCP'),
                      ]),
                      React.createElement('div', { key: 'total', style: probeStatStyle }, [
                        React.createElement('span', { key: 'v', style: probeStatValueStyle }, `${probeResult.totalMs ?? '—'} ms`),
                        React.createElement('span', { key: 'l', style: probeStatLabelStyle }, '总延迟（经代理）'),
                      ]),
                      React.createElement('div', { key: 'status', style: probeStatStyle }, [
                        React.createElement('span', { key: 'v', style: probeStatValueStyle }, String(probeResult.httpStatus ?? '—')),
                        React.createElement('span', { key: 'l', style: probeStatLabelStyle }, '目标状态'),
                      ]),
                    ])
                  : null,
              ])
            : null,
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
        const [busy, setBusy] = React.useState(false);
        const [saved, setSaved] = React.useState(false);
        const [error, setError] = React.useState<string | null>(null);

        const save = async (): Promise<void> => {
          const parsed = Math.max(0, Math.min(20, Math.floor(Number(maxRetries) || 0)));
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            await saveSection(props.api, { retryEnabled: enabled, maxRetries: parsed }, props.revision, props.onRevision);
            setSaved(true);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(/conflict/i.test(message) ? '设置已在其它窗口或进程中被修改，请重新保存。' : `保存失败：${message}`);
            setSaved(false);
          } finally {
            setBusy(false);
          }
        };

        return React.createElement('section', { style: cardStyle }, [
          React.createElement('div', { key: 'head', style: cardHeadStyle }, [
            React.createElement('h3', { key: 'title', style: cardTitleStyle }, '请求重试'),
            React.createElement(
              'span',
              { key: 'badge', style: enabled ? badgeOkStyle : badgeStyle },
              enabled ? `最多重试 ${maxRetries} 次` : '已关闭',
            ),
          ]),
          React.createElement('div', { key: 'switch', style: switchStyle }, [
            React.createElement('input', {
              key: 'sw-input',
              type: 'checkbox',
              id: 'dns-retry-enabled',
              checked: enabled,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                setEnabled(event.target.checked);
                setSaved(false);
              },
              disabled: !props.writable,
              style: { width: 16, height: 16 },
            }),
            React.createElement('label', { key: 'sw-label', htmlFor: 'dns-retry-enabled' }, '启用自动重试'),
          ]),
          React.createElement('div', { key: 'field', style: fieldStyle }, [
            React.createElement('label', { key: 'count-label', htmlFor: 'dns-retry-count', style: labelStyle }, '最大请求重试次数'),
            React.createElement('input', {
              key: 'count-input',
              id: 'dns-retry-count',
              type: 'number',
              min: 0,
              max: 20,
              step: 1,
              value: maxRetries,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                setMaxRetries(event.target.value);
                setSaved(false);
              },
              disabled: !props.writable || !enabled,
              style: { ...monoInputStyle, maxWidth: 120 },
            }),
            React.createElement(
              'span',
              { key: 'retry-hint', style: hintStyle },
              '对 dsh 所有出站请求（LLM API 调用、web 搜索 / 抓取、外部 API 等）在网络错误或 429 / 5xx 时自动重试，至多该次数；0 = 不重试。退避：500ms 起、指数递增、上限 10s。',
            ),
          ]),
          React.createElement(SaveActions, {
            key: 'actions',
            busy,
            writable: props.writable,
            saved,
            error,
            onSave: save,
          }),
        ]);
      }

      /** 「网络设置」标签页主体：加载一次命名空间，分发给三块卡片。 */
      function NetworkSettingsSection(props: { api: IApiClient }): React.ReactElement {
        const api = props.api;
        const [ready, setReady] = React.useState(false);
        const [writable, setWritable] = React.useState(true);
        const [revision, setRevision] = React.useState(0);
        const [initial, setInitial] = React.useState<NamespaceValue | null>(null);

        React.useEffect(() => {
          let cancelled = false;
          (async () => {
            try {
              const loaded = await loadNamespace(api);
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
        }, [api]);

        if (!ready) {
          return React.createElement('div', { style: hintStyle }, '正在读取网络设置…');
        }

        return React.createElement('div', { style: rootStyle }, [
          React.createElement(
            'p',
            { key: 'lead', style: leadStyle },
            '统一配置 dsh 的出站网络行为：User-Agent 改写、HTTP/CONNECT/SOCKS5 代理与请求自动重试。改动在保存后对下一条请求立即生效；三块设置互不影响，可分别保存。',
          ),
          React.createElement(UaCard, {
            key: 'ua',
            api,
            initial: initial ?? {},
            revision,
            writable,
            onRevision: setRevision,
          }),
          React.createElement(ProxyCard, {
            key: 'proxy',
            api,
            initial: initial ?? {},
            revision,
            writable,
            onRevision: setRevision,
          }),
          React.createElement(RetryCard, {
            key: 'retry',
            api,
            initial: initial ?? {},
            revision,
            writable,
            onRevision: setRevision,
          }),
          !writable
            ? React.createElement('p', { key: 'ro', style: leadStyle }, '当前设置为只读，无法保存。')
            : null,
        ]);
      }

      const plugin = {
        name: '@dsh-plugin/dsh-network-settings',
        inject: ['slots', 'connection'],
        apply(ctx: { get<T = unknown>(service: string): T | undefined }): void {
          const slots = ctx.get<{
            inject(name: string, callback: () => unknown): unknown;
            register(options: unknown, component: unknown): unknown;
          }>('slots');
          const connection = ctx.get<{ api: IApiClient }>('connection');
          if (slots === undefined || connection === undefined) {
            return;
          }
          slots.inject('settings.section', () =>
            slots.register(
              {
                name: 'settings.section',
                id: 'dsh-network-settings',
                order: 30,
                label: () => '网络设置',
                inject: () => ({ api: connection.api }),
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