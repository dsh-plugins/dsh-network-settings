/**
 * 旧 dsh-net-proxy 配置文件（~/.dsh/net-proxy.json）的读取与投影（TS 化）。
 *
 * 仅用作「网络设置」插件的升级迁移：新配置以 dsh-settings 命名空间为准，
 * 此模块负责把旧文件中的代理字段并入命名空间的 base 层（用户已保存的值
 * 仍然优先）。也提供探测/代理内部使用的 toProxy 投影。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 旧 dsh-net-proxy 配置形状（宽松，兼容历史字段）。 */
export interface LegacyProxyConfig {
  enabled?: boolean;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  noProxy?: string[];
  [key: string]: unknown;
}

/** 旧配置文件路径：$DSH_HOME/net-proxy.json 或 ~/.dsh/net-proxy.json。 */
export function configPath(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'net-proxy.json');
}

/** 旧配置默认值。 */
export function defaults(): LegacyProxyConfig {
  return {
    enabled: false,
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
    username: '',
    password: '',
    noProxy: ['127.0.0.1', 'localhost', '::1'],
  };
}

/** 读取旧配置（文件缺失 / 解析失败 → 默认值）。 */
export function loadConfig(file: string = configPath()): LegacyProxyConfig {
  try {
    if (fs.existsSync(file)) {
      let raw = fs.readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥离 UTF-8 BOM
      const parsed: unknown = JSON.parse(raw);
      return { ...defaults(), ...(parsed && typeof parsed === 'object' ? (parsed as LegacyProxyConfig) : {}) };
    }
  } catch (err) {
    console.error(`[dsh-network-settings] 读取旧代理配置失败 ${file}:`, (err as Error)?.message);
  }
  return defaults();
}

/** 写回旧配置格式（供升级迁移写回 / 测试）。 */
export function writeConfig(cfg?: LegacyProxyConfig | Record<string, unknown>, file: string = configPath()): LegacyProxyConfig {
  const merged = { ...defaults(), ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}

/** 归一化任意输入为完整旧配置。 */
export function toCfg(value?: Record<string, unknown> | null): LegacyProxyConfig {
  return { ...defaults(), ...(value && typeof value === 'object' ? value : {}) };
}

/** 投影为代理引擎使用的 NetProxy（含 noProxy 兜底）。 */
export function toProxy(cfg?: Record<string, unknown> | null): {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  noProxy: string[];
} {
  const c = toCfg(cfg ?? {});
  return {
    protocol: typeof c.protocol === 'string' ? c.protocol : 'http',
    host: typeof c.host === 'string' ? c.host : '127.0.0.1',
    port: Number(c.port) || 7890,
    username: typeof c.username === 'string' && c.username ? c.username : undefined,
    password: typeof c.password === 'string' && c.password ? c.password : undefined,
    noProxy: Array.isArray(c.noProxy) && c.noProxy.length ? (c.noProxy as string[]) : ['127.0.0.1', 'localhost', '::1'],
  };
}