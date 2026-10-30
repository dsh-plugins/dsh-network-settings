# dsh-network-settings 2.0.0

为 dsh 提供 User-Agent 改写、HTTP / CONNECT / SOCKS5 代理和请求自动重试。依赖 **dsh-loader ^2.0.0** 与 **Node.js >=24.9.0**。

配置由 loader 根据声明模板统一生成：三个配置组放在同一张默认折叠的“网络设置”卡片中，共用保存、取消修改和恢复默认值。保存后下一条请求即生效。

- 早于 `0.1.6-alpha.2`：设置 → 插件配置。
- 从 `0.1.6-alpha.2` 起：插件 → `@dsh-plugin/dsh-network-settings` 详情。
- 文件：`<profile>/config/dsh-network-settings/config.json`。密码不以明文回传浏览器，修订冲突不会覆盖草稿。

代理支持 NO_PROXY、认证、超时、压缩响应和重定向。重试支持网络错误与 429/500/502/503/504；取消请求和不可重放的流不会重试。卸载会停用自己的 fetch 补丁，并保留后装的第三方包装器。

## 迁移与诊断

旧自管配置页面和 `/_dsh/dsh-network-settings/settings` 路由已移除。entry 配置和旧 `$DSH_HOME/net-proxy.json` 仍作为首次注册的默认值；新文件存在时以已保存值为准。旧 settings namespace 不会自动搬迁，升级前请记录其中的自定义值，在新表单中保存。卸载不删除配置文件。

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
