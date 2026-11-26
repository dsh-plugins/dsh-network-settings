# dsh-network-settings 2.0.0

为 DSH 提供 User-Agent 改写、HTTP / CONNECT / SOCKS5 代理、响应空闲超时和请求自动重试。依赖 **dsh-loader ^2.0.0** 与 **Node.js >=24.9.0**。

配置由 loader 生成，可在「网络策略」和「本机代理连接」卡片中分别保存。

- 早于 `0.1.6-alpha.2`：设置 → 插件配置。
- 从 `0.1.6-alpha.2` 起：插件 → `@dsh-plugin/dsh-network-settings` 详情。
- 网络策略保存在 `<profile>/config/dsh-network-settings-policy/config.json`，可在 PackForge 导出时勾选。
- 代理开关、端点及凭据保存在 `<profile>/config/dsh-network-settings-connection/config.json`。PackForge 排除该目录，浏览器只收到密码引用。

「响应空闲超时」默认 240 秒，可在 `requestIdleTimeoutMs` 中以毫秒设置。它分别限制等待响应头和等待下一段响应数据的时间，持续返回数据的长响应可以继续。升级后，旧 `proxyTimeoutMs` 只用于建立代理连接。

保存后，普通请求立即采用新值，pi-ai 适配器自动重载。没有设置 `streamIdleTimeoutMs` 的提供商将采用这个默认值，HTTP 和 WebSocket 模型流均适用。已设置的提供商值继续生效。HTTP 模型请求还受通用响应空闲超时约束，由先到期的计时器中断。

代理支持直连规则、认证、压缩响应和重定向。清空直连规则后，本插件代理可接收所有目标。显式指定 dispatcher 的请求沿用调用方的传输设置。请求可重放时，首包超时、可重试连接错误和 HTTP 429/500/502/503/504 会触发重试。

当 Anthropic 兼容网关返回 `stream_read_error` 且 pi-ai 将其归类为 `PI_AI_ERROR` 时，插件在 DSH 结算失败响应后按「最大重试次数」重新发起当前模型步骤。DSH 已决定重试时，沿用宿主的决定。

## 迁移与诊断

旧自管配置页面和 `/_dsh/dsh-network-settings/settings` 路由已移除。启动时将旧 `<profile>/config/dsh-network-settings/config.json` 分别迁移到尚未保存的新配置文件。组合配置和旧 `$DSH_HOME/net-proxy.json` 提供默认值。配置 API 使用 `dsh-network-settings-policy` 和 `dsh-network-settings-connection` 两个 ID。旧文件留在本机，PackForge 排除这些文件。已有通过 Cordis 补丁填写的认证信息，应移入「本机代理连接」卡片并从补丁删除后再分享。旧 settings namespace 不会自动搬迁，升级前请记录其中的自定义值，在新表单中保存。卸载不删除配置文件。

连接探测接口 `/_dsh/dsh-network-settings/probe` 保留，并使用宿主浏览器认证。GET 探活，POST 使用已保存配置或显式代理覆盖进行连通性测试。统一配置模板没有自定义动作按钮，因此 2.0 不再附带插件自管的“测试连接”按钮。

支持 loader 的六个 patch 系列。`0.1.6-alpha.1` 的默认上游依赖解析存在启动冲突，固定同版 app-boot 后通过；详见[真实启动测试记录](docs/testing-2.0.md)。

## 本地开发

本次开发依赖指向相邻的 `../dsh-loader` 2.0 工作区。先在那里构建，再在本仓库执行：

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
npm pack --dry-run
```

逐版复测入口为 `scripts/prepare-launch.mjs` 和 `scripts/test-launch.mjs`，使用 `.cache` 下的独立安装和 profile，不使用用户实际 profile。前者需要 pnpm，非默认安装位置可通过 `PNPM_CLI` 指定其 JS 入口。当前版本清单来自相邻 loader 的冻结 fixture。

MIT License。
