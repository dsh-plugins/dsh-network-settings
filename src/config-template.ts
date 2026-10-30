import { defineConfig } from '@dsh-plugin/dsh-loader/config';
import type { PluginConfig } from './index.js';

/** Composition values seed the first registration; saved profile values win. */
export function createConfigTemplate(base: PluginConfig) {
  return defineConfig({
    id: 'dsh-network-settings',
    packageName: '@dsh-plugin/dsh-network-settings',
    title: '网络设置',
    description: 'User-Agent、代理与请求重试。保存后对下一条请求生效。',
    fields: [
      { type: 'group', label: 'User-Agent', fields: [
        { type: 'boolean', key: 'uaEnabled', label: '改写 User-Agent', default: base.uaEnabled },
        { type: 'text', key: 'userAgent', label: 'User-Agent', default: base.userAgent, description: '关闭改写时保留调用方的请求头。' },
      ] },
      { type: 'group', label: '网络代理', fields: [
        { type: 'boolean', key: 'proxyEnabled', label: '启用代理', default: base.proxyEnabled },
        { type: 'select', key: 'proxyProtocol', label: '代理协议', default: base.proxyProtocol, options: [{ label: 'HTTP / CONNECT', value: 'http' }, { label: 'SOCKS5', value: 'socks5' }] },
        { type: 'text', key: 'proxyHost', label: '代理地址', default: base.proxyHost, required: true },
        { type: 'number', key: 'proxyPort', label: '代理端口', default: base.proxyPort, min: 1, max: 65535 },
        { type: 'text', key: 'proxyUsername', label: '用户名', default: base.proxyUsername },
        { type: 'password', key: 'proxyPassword', label: '密码', default: base.proxyPassword, description: '留空保持已保存密码；使用“清空”显式删除。' },
        { type: 'array', key: 'proxyNoProxy', label: '直连规则', default: base.proxyNoProxy, description: '支持域名、后缀、host:port、IPv4 CIDR、* 与 <local>。', item: { type: 'text', label: '规则', required: true } },
        { type: 'number', key: 'proxyTimeoutMs', label: '超时（毫秒）', default: base.proxyTimeoutMs, min: 1, max: 3600000 },
      ] },
      { type: 'group', label: '请求重试', fields: [
        { type: 'boolean', key: 'retryEnabled', label: '启用自动重试', default: base.retryEnabled },
        { type: 'number', key: 'maxRetries', label: '最大重试次数', default: base.maxRetries, min: 0, max: 20, description: '0 表示不重试。取消请求与不可重放的流不会重试。' },
      ] },
    ],
  });
}
