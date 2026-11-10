import { AsyncLocalStorage } from 'node:async_hooks';
import { createPatchAPI } from '@dsh-plugin/dsh-loader/patch';
import { Agent, Client, ProxyAgent, buildConnector, getGlobalDispatcher, type Dispatcher } from 'undici';
import { socksConnect, type NetProxy } from './conn.js';
import { isNoProxy } from './no-proxy.js';
import type { FetchType } from '../ua.js';

export const DEFAULT_REQUEST_IDLE_TIMEOUT_MS = 240_000;
export const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 60_000;

/** 支持原生 Fetch 参数及旧版探测调用使用的 URL 对象。 */
export type FetchInput = RequestInfo | URL | { url?: string; method?: string };
export type OriginalFetch = (input: string, init?: RequestInit) => Promise<Response>;

type FetchInit = RequestInit & { dispatcher?: Pick<Dispatcher, 'dispatch'> };
type Dispatch = Dispatcher['dispatch'];
type DispatchRoute = (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler, direct: Dispatch) => boolean;

const dispatchScope = new AsyncLocalStorage<{ target: Dispatcher; route: DispatchRoute }>();
const defaultPatches = new WeakMap<Dispatcher, { active: number; dispose(): void }>();

async function fetchWithRequestDispatcher(original: FetchType, input: Request, init: RequestInit | undefined, route: DispatchRoute) {
  const target = getGlobalDispatcher();
  let patch = defaultPatches.get(target);
  if (!patch) {
    // Node 的 Request 可持有调用方指定的 dispatcher。让原生 Fetch 选择它，
    // 仅在本次请求回到宿主默认 dispatcher 时应用插件策略。
    const handle = createPatchAPI().method(target, 'dispatch', direct =>
      function (this: Dispatcher, options, handler) {
        const scope = dispatchScope.getStore();
        if (scope?.target === target) {
          return scope.route(options, handler, direct.bind(this));
        }
        return direct.call(this, options, handler);
      }, { id: 'dsh-network-settings:request-dispatch' });
    patch = { active: 0, dispose: handle.dispose };
    defaultPatches.set(target, patch);
  }
  patch.active++;
  try {
    return await dispatchScope.run({ target, route }, () => original(input, init));
  } finally {
    if (--patch.active === 0) {
      patch.dispose();
      defaultPatches.delete(target);
    }
  }
}

function makeProxyDispatcher(proxy: NetProxy, pendingConnections: Set<AbortController>): Dispatcher {
  const timeout = Math.trunc(proxy.connectTimeout ?? DEFAULT_PROXY_CONNECT_TIMEOUT_MS);
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks') {
    const tls = buildConnector({ allowH2: true, timeout });
    return new Agent({
      allowH2: true,
      connect(options, callback) {
        const host = options.hostname.replace(/^\[(.*)\]$/, '$1');
        const secure = options.protocol === 'https:';
        const port = Number(options.port) || (secure ? 443 : 80);
        const controller = new AbortController();
        pendingConnections.add(controller);
        const connected: buildConnector.Callback = (...args) => {
          pendingConnections.delete(controller);
          callback(...args);
        };
        void socksConnect(proxy, host, port, timeout, controller.signal).then(
          socket => {
            if (secure) {
              try {
                tls({ ...options, hostname: host, httpSocket: socket }, connected);
              } catch (error) {
                socket.destroy();
                connected(error as Error, null);
              }
            } else {
              connected(null, socket);
            }
          },
          (error: Error) => connected(error, null),
        );
      },
    });
  }

  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  if (/[\s\\/?#@]/.test(host)) {
    throw new TypeError('HTTP 代理地址必须为主机名或 IP 地址');
  }
  const endpoint = new URL(`http://${host}:${proxy.port}`);
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new TypeError('HTTP 代理地址必须为主机名或 IP 地址');
  }
  const token = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}`
    : undefined;
  return new ProxyAgent({
    uri: endpoint.href,
    proxyTunnel: false,
    allowH2: true,
    token,
    proxyTls: { timeout },
    requestTls: { timeout, allowH2: true },
    clientFactory: (origin, options) => new Client(origin, { ...options, headersTimeout: timeout }),
  });
}

export function createTransport(original: FetchType, timeoutMs: number, proxy?: NetProxy, onCloseError?: (error: unknown) => void) {
  let agent: Dispatcher | undefined;
  const pendingConnections = new Set<AbortController>();
  let active = 0;
  let retired = false;

  const closeWhenIdle = () => {
    if (retired && active === 0 && agent) {
      const closing = agent;
      agent = undefined;
      // close 等待已返回给调用方的响应体结束，因此清理不能阻塞 fetch。
      void closing.close().catch(error => {
        if (onCloseError) {
          onCloseError(error);
        } else {
          console.error('[dsh-network-settings] 释放代理连接池失败', error);
        }
      });
    }
  };
  const idle = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.trunc(timeoutMs))
    : DEFAULT_REQUEST_IDLE_TIMEOUT_MS;
  const route: DispatchRoute = (options, handler, direct) => {
    const timed = { ...options, headersTimeout: idle, bodyTimeout: idle };
    if (!proxy || isNoProxy(String(options.origin), proxy.noProxy)) {
      return direct(timed, handler);
    }
    agent ??= makeProxyDispatcher(proxy, pendingConnections);
    return agent.dispatch(timed, handler);
  };
  const dispatcher: Pick<Dispatcher, 'dispatch'> = {
    dispatch(options, handler) {
      const direct = getGlobalDispatcher();
      return route(options, handler, direct.dispatch.bind(direct));
    },
  };

  const fetch: FetchType = (input, init?: FetchInit) => {
    if (init?.dispatcher) {
      return original(input, init);
    }
    if (input instanceof Request) {
      return fetchWithRequestDispatcher(original, input, init, route);
    }
    const timed: FetchInit = { ...init, dispatcher };
    return original(input, timed);
  };

  return {
    async run(call: (send: FetchType) => Promise<Response>) {
      active++;
      try {
        return await call(fetch);
      } finally {
        active--;
        if (active === 0) {
          for (const controller of pendingConnections) {
            controller.abort();
          }
        }
        closeWhenIdle();
      }
    },
    retire() {
      retired = true;
      closeWhenIdle();
    },
  };
}

/** 使用代理发送单个 Fetch 请求，保留原生 Fetch 的输入和响应语义。 */
export async function proxiedFetch(
  input: FetchInput,
  init: RequestInit = {},
  proxy: NetProxy,
  originalFetch: FetchType | OriginalFetch,
): Promise<Response> {
  if (typeof input !== 'string' && !(input instanceof URL) && !(input instanceof Request)) {
    init = { ...init, method: init.method ?? input.method };
    input = input.url ?? String(input);
  }
  const transport = createTransport(
    originalFetch as FetchType, proxy.timeout ?? DEFAULT_REQUEST_IDLE_TIMEOUT_MS, proxy,
  );
  try {
    return await transport.run(send => send(input as RequestInfo | URL, init));
  } finally {
    transport.retire();
  }
}
