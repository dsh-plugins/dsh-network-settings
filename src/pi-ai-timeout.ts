import type { CordisContext, HostAPI } from '@dsh-plugin/dsh-loader';
import type { ConfigHandle } from '@dsh-plugin/dsh-loader/config';
import type { NetworkPolicyConfig } from './index.js';

const PI_AI = '@deepseek-ai/dsh-llm-pi-ai';
const PI_AI_NAMESPACE = 'llm-pi-ai';
const LOADING = 1;
const ACTIVE = 2;
const UNLOADING = 5;

type Schema = (raw: unknown) => unknown;
interface LegacySettings {
  installSection(owner: unknown, namespace: unknown, schema: Schema, entry: unknown, hooks: unknown): void;
}

interface Entry {
  options: { name?: string };
  fiber?: Fiber;
}

interface Fiber {
  entry?: Entry;
  parent?: { fiber?: Fiber };
  state: number;
  await(): Promise<unknown>;
  restart(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withIdleDefault(raw: unknown, timeout: number): unknown {
  if (!isRecord(raw) || !isRecord(raw.providers)) {
    return raw;
  }
  const providers = Object.entries(raw.providers).map(([name, profile]) => [
    name,
    isRecord(profile) && profile.streamIdleTimeoutMs === undefined
      ? { ...profile, streamIdleTimeoutMs: timeout }
      : profile,
  ]);
  return { ...raw, providers: Object.fromEntries(providers) };
}

export function installPiAiTimeout(
  ctx: CordisContext & { dshLoader: HostAPI; root?: unknown },
  config: Pick<ConfigHandle<NetworkPolicyConfig>, 'get' | 'watch'>,
): void {
  const loader = ctx.dshLoader.services.get('loader') as { entries?(): Iterable<Entry> } | undefined;
  const on = ctx.on?.bind(ctx);
  if (!on || typeof loader?.entries !== 'function') {
    return;
  }

  ctx.effect(() => {
    let timeout = Math.trunc(config.get().value.requestIdleTimeoutMs);
    let queue = Promise.resolve();
    let disposed = false;
    const refresh = async () => {
      for (const entry of loader.entries!()) {
        const fiber = entry.fiber;
        if (entry.options.name !== PI_AI || !fiber) {
          continue;
        }
        try {
          // 配置可能已被正在重载的适配器读取，等它完成后再应用新默认值。
          if (fiber.state === LOADING || fiber.state === UNLOADING) {
            await fiber.await();
          }
          if (entry.fiber === fiber && fiber.state === ACTIVE) {
            await fiber.restart();
          }
        } catch (error) {
          ctx.logger?.warn?.('[dsh-network-settings] 重载 pi-ai 超时配置失败', error);
        }
      }
    };
    const scheduleRefresh = () => {
      queue = queue.then(() => disposed ? undefined : refresh()).catch(error => {
        ctx.logger?.warn?.('[dsh-network-settings] 读取 pi-ai 适配器列表失败', error);
      });
    };

    const unhook = on('internal/config', function (this: Fiber, input: unknown, next: () => unknown) {
      const raw = next();
      // Cordis 新版把 Fiber 作为参数，旧版通过 this 传递。
      const fiber = isRecord(input) && 'entry' in input && 'restart' in input ? input as unknown as Fiber : this;
      const entry = fiber?.entry;
      if (disposed || entry?.options.name !== PI_AI || fiber.parent?.fiber?.entry === entry) {
        return raw;
      }
      return withIdleDefault(raw, timeout);
    }, { global: true });

    // Cordis 为每次服务属性读取生成带作用域的包装方法，补丁必须绑定到方法的声明位置。
    const settings = ctx.dshLoader.services.get('settings') as { constructor: { prototype: Partial<LegacySettings> } } | undefined;
    const settingsPrototype = settings?.constructor.prototype;
    const legacy = typeof settingsPrototype?.installSection === 'function'
      ? ctx.dshLoader.patch.method(settingsPrototype as LegacySettings, 'installSection', original =>
        function (this: LegacySettings, owner, namespace, schema, entry, hooks) {
          const root = (owner as { root?: unknown } | undefined)?.root;
          if (String(namespace) !== PI_AI_NAMESPACE || root !== ctx.root) {
            return original.call(this, owner, namespace, schema, entry, hooks);
          }
          // 旧版设置把保存的提供商与组合配置合并后才调用 schema。
          const wrapped = new Proxy(schema, {
            apply(target, receiver, [raw]) {
              return target.call(receiver, disposed ? raw : withIdleDefault(raw, timeout));
            },
          });
          return original.call(this, owner, namespace, wrapped, entry, hooks);
        }, { owner: ctx })
      : undefined;

    const unwatch = config.watch(({ value }) => {
      const next = Math.trunc(value.requestIdleTimeoutMs);
      if (next !== timeout) {
        timeout = next;
        scheduleRefresh();
      }
    });
    scheduleRefresh();

    return async () => {
      disposed = true;
      unwatch();
      unhook?.();
      legacy?.dispose();
      await queue;
      await refresh();
    };
  }, 'dsh-network-settings: pi-ai idle timeout');
}
