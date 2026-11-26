import { defineConfig } from '@dsh-plugin/dsh-loader/config';
import type { NetworkPolicyConfig, PluginConfig, ProxyConnectionConfig } from './index.js';

export const POLICY_CONFIG_ID = 'dsh-network-settings-policy';
export const CONNECTION_CONFIG_ID = 'dsh-network-settings-connection';
const PACKAGE_NAME = '@dsh-plugin/dsh-network-settings';

/** 从组合配置提供默认值，已保存的配置档设置优先。 */
export function createConfigTemplate(base: NetworkPolicyConfig) {
  return defineConfig({
    id: POLICY_CONFIG_ID,
    packageName: PACKAGE_NAME,
    title: '网络策略',
    description: '设置 User-Agent、代理直连规则、超时与重试。更改响应空闲超时后自动重载 pi-ai 适配器。',
    fields: [
      { type: 'group', label: 'User-Agent', fields: [
        { type: 'boolean', key: 'uaEnabled', label: '改写 User-Agent', default: base.uaEnabled },
        { type: 'text', key: 'userAgent', label: 'User-Agent', default: base.userAgent, description: '关闭改写时保留调用方的请求头。' },
      ] },
      { type: 'group', label: '代理规则', fields: [
        { type: 'array', key: 'proxyNoProxy', label: '直连规则', default: base.proxyNoProxy, description: '支持域名、后缀、host:port、IPv4 CIDR、* 与 <local>。清空后所有目标均可使用代理。', item: { type: 'text', label: '规则', required: true } },
        { type: 'number', key: 'proxyTimeoutMs', label: '代理建连超时（毫秒）', default: base.proxyTimeoutMs, min: 1, max: 3600000 },
      ] },
      { type: 'group', label: '请求超时', fields: [
        { type: 'number', key: 'requestIdleTimeoutMs', label: '响应空闲超时（毫秒）', default: base.requestIdleTimeoutMs, min: 1, max: 3600000, description: '等待响应头或下一段数据的最长时间。持续输出的流可以继续。此值也是 pi-ai 模型的默认流式空闲超时。' },
      ] },
      { type: 'group', label: '请求重试', fields: [
        { type: 'boolean', key: 'retryEnabled', label: '启用自动重试', default: base.retryEnabled },
        { type: 'number', key: 'maxRetries', label: '最大重试次数', default: base.maxRetries, min: 0, max: 20, description: '0 表示关闭本插件的重试。模型响应收到上游断流错误时，可重试当前模型步骤。' },
      ] },
    ],
  });
}

/** 将代理端点和凭据保存在同一文件，导入策略时保留本机连接。 */
export function createConnectionTemplate(base: ProxyConnectionConfig) {
  return defineConfig({
    id: CONNECTION_CONFIG_ID,
    packageName: PACKAGE_NAME,
    title: '本机代理连接',
    description: '代理地址和凭据保存在此配置档，PackForge 导出时排除此设置。',
    fields: [
      { type: 'boolean', key: 'proxyEnabled', label: '启用代理', default: base.proxyEnabled },
      { type: 'select', key: 'proxyProtocol', label: '代理协议', default: base.proxyProtocol, options: [{ label: 'HTTP / CONNECT', value: 'http' }, { label: 'SOCKS5', value: 'socks5' }] },
      { type: 'text', key: 'proxyHost', label: '代理地址', default: base.proxyHost, required: true },
      { type: 'number', key: 'proxyPort', label: '代理端口', default: base.proxyPort, min: 1, max: 65535 },
      { type: 'text', key: 'proxyUsername', label: '用户名', default: base.proxyUsername },
      { type: 'password', key: 'proxyPassword', label: '密码', default: base.proxyPassword, description: '留空保持已保存密码；使用“清空”显式删除。' },
    ],
  });
}

/** 复用 loader 校验读取旧版合并配置。 */
export function createLegacyConfigTemplate(id: string, base: PluginConfig) {
  return defineConfig({
    id,
    packageName: PACKAGE_NAME,
    title: '网络设置',
    fields: [...createConfigTemplate(base).fields, ...createConnectionTemplate(base).fields],
  });
}
