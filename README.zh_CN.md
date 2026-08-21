# @dsh-plugin/dsh-network-settings

一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件，将三块网络能力集成于一体 —— **User-Agent 改写**（源自 [@dsh-plugin/dsh-user-agent](https://github.com/dsh-plugins/dsh-user-agent)）、**HTTP / HTTPS-CONNECT / SOCKS5 代理**（源自 [dsh-net-proxy](https://github.com/mafeis/dsh-net-proxy)）与**可配置的请求自动重试** —— 全部由 Web 设置里的同一个「**网络设置**」标签页驱动。

## 功能

- **User-Agent 改写** —— 对所有走全局 `fetch` 的出站请求（`dsh-llm-deepseek` 的 LLM API 调用、web 搜索、HTTP 工具等）强制写入自定义的 `User-Agent`，覆盖调用方自带头。可开关、可编辑，下一条请求即生效。
- **网络代理** —— 让 agent 的网络请求经 HTTP（CONNECT 隧道）或 SOCKS5 代理发出；支持可选用户名/密码、`NO_PROXY` 直连清单（host / 后缀 / `host:port` / IPv4 CIDR / `*` / `<local>`）与请求超时。设置页提供「**测试连接**」按钮，执行真实连通性 + 延迟探测（代理 TCP 握手、整体往返耗时、目标 HTTP 状态码）。
- **请求自动重试** —— 配置「**最大请求重试次数**」（0 = 不重试）：出站请求因网络层错误（undici 连接失败/超时/复位等错误码）或可重试状态码（`429`、`500`、`502`、`503`、`504`）失败时自动重试，采用有界指数退避（500ms 起、上限 10s）+ 10% 抖动。取消（Abort）与不可重放的流式 body 永不重试；仅当 body 可重放（string / URLSearchParams / ArrayBuffer / Blob / FormData）时才整体重放请求。
- **一个标签页、三块独立保存** —— UA、代理、重试三块各有自己的「**保存**」按钮；保存后对下一条请求立即生效，无需重启。全部值存于标准 `dsh-network-settings` 用户设置命名空间。
- **干净的生命周期** —— 仅在插件运行期间包装 `globalThis.fetch`；原始 fetch 只捕获一次，插件停止 / 更新 / 卸载时恢复。
- **同源探测路由** —— `/_dsh/dsh-network-settings/probe` 执行代理连通探测（只读，绝不写配置）。

## 安装

本包是一个 [dsh bundle 插件](https://github.com/dsh-plugins)（`dsh.bundle.patch`），可用标准的 `dsh plugin add` 命令安装：

```bash
dsh plugin add @dsh-plugin/dsh-network-settings
# 或指定 profile
dsh plugin --profile web add @dsh-plugin/dsh-network-settings
```

然后在 Web GUI 打开 **设置 → 网络设置**：修改三块中的任意一块并点击对应「**保存**」。

### 替换旧插件

本插件已完整实现 `@dsh-plugin/dsh-user-agent` 与 `dsh-net-proxy` 的功能，安装后可将其从 profile 移除：

```bash
dsh plugin remove @dsh-plugin/dsh-user-agent
dsh plugin remove net-proxy
```

已有数据自动迁移：若旧 `~/.dsh/net-proxy.json`（或 `$DSH_HOME/net-proxy.json`）存在，其代理字段会在启动时并入本插件的 base 层（你在「网络设置」标签页保存的值永远优先）。

## 配置

插件入口（`cordis.patch.yml` / profile 覆盖）—— 取值作为组合 `base` 层，与用户设置部分合并：

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `uaEnabled` | `boolean` | `true` | UA 改写总开关；关闭时原样透传调用方的 User-Agent。 |
| `userAgent` | `string` | `DeepSeek-Harness/0.1 (+https://github.com/deepseek-ai/dsh)` | 应用到每条出站请求的 User-Agent。 |
| `proxyEnabled` | `boolean` | `false` | 代理总开关；关闭时直连。 |
| `proxyProtocol` | `string` | `http` | 代理协议：`http`（CONNECT 隧道）或 `socks5`。 |
| `proxyHost` | `string` | `127.0.0.1` | 代理地址。 |
| `proxyPort` | `number` | `7890` | 代理端口。 |
| `proxyUsername` | `string` | `''` | 代理用户名（可选）。 |
| `proxyPassword` | `string` | `''` | 代理密码（可选）。 |
| `proxyNoProxy` | `string[]` | `['127.0.0.1','localhost','::1']` | 直连清单；命中则不经代理。 |
| `proxyTimeoutMs` | `number` | `60000` | 代理请求超时（毫秒）。 |
| `retryEnabled` | `boolean` | `true` | 自动重试总开关。 |
| `maxRetries` | `number` | `2` | 最大请求重试次数（0 = 不重试）。 |

## 工作原理

- Host 半边安装 `dsh-network-settings` 设置命名空间（`installSettingsSection`），对 `globalThis.fetch` 一次性包装三层栈，每次请求按需读取：`重试 → UA 改写 → 代理 → 原始 fetch`。被重试的每次尝试都会重新读取最新解析配置，因此保存后的改动对下一条请求立即生效。
- 代理引擎移植自 dsh-net-proxy：HTTP 绝对 URL 转发、HTTPS 走 CONNECT、SOCKS5 协商（含 RFC 1929 认证）、流式响应体（gzip / br / deflate 解压）、ALPN HTTP/2、重定向跟随、NO_PROXY 判定。
- 浏览器半边注册 `settings.section` 标签页，通过连接层 ApiProxy（`api.settings.describe` / `update`）读写命名空间，与 dsh 主线/aux 插件同一缝；代理连通性测试走同源探测路由。

## 开发

```bash
npm install          # 开发依赖 + 自动安装的 peer
npm run build        # tsc（host + client）+ 剥离 client module-ification 产物
npm test             # node --test（Node ≥ 23.6 原生运行 TypeScript 测试）
npm pack --dry-run   # 查看发布内容
```

全部源码 —— Host、代理引擎、设置页 UI 与测试 —— 均为 TypeScript。

## License

MIT