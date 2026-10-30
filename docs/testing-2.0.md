# 2.0.0 真实启动验收

2026-10-30，Windows / Node 24.18.0 / pnpm 11.10.0。插件与本地 dsh-loader 均为 2.0.0。

24 个发布版分别安装、逐一启动真实 CLI 及完整 web profile；每版使用独立 DSH_HOME，测试配置存储在仓库 `.cache` 中。没有使用用户实际 profile。依赖解析锁保存在各隔离安装目录，SHA-256 随 [JSON 结果](launch-results-2.0.json) 保存。

每版均通过：宿主启动、浏览器认证、config-api 注册与读写、密码遮蔽、磁盘文件落盘、过期修订号返回 409、真实宿主 fetch 的 User-Agent 改写、启动脚本中的版本描述、探测接口探活。网络引擎另有 36 项单元与集成测试，覆盖 HTTP 代理、压缩、重定向和重试等。

## 上游依赖例外

`0.1.6-alpha.1` 的默认安装解析到的 app-boot 不再导出 `watchUserPatches`，CLI 在执行插件前即因静态导入失败退出。仅对该 CLI 的直接依赖固定 `dsh-app-boot@0.1.6-alpha.1` 后，完整链路通过。该结果有条件，不能解释为原始依赖组合也能启动。

pnpm 11 的配置位于安装目录的 `pnpm-workspace.yaml`：

```yaml
overrides:
  "@deepseek-ai/dsh@0.1.6-alpha.1>@deepseek-ai/dsh-app-boot": "0.1.6-alpha.1"
```

## 版本结果

| dsh | 真实启动和功能检查 |
|---|---|
| `0.1.5-alpha.1` | 通过 |
| `0.1.5-alpha.2` | 通过 |
| `0.1.5-rc.1` | 通过 |
| `0.1.5-rc.2` | 通过 |
| `0.1.5-rc.3` | 通过 |
| `0.1.6-alpha.1` | 通过（上述依赖固定） |
| `0.1.6-alpha.2` | 通过 |
| `0.1.7-alpha.1` | 通过 |
| `0.1.7-alpha.2` | 通过 |
| `0.1.7-rc.1` | 通过 |
| `0.1.7-rc.2` | 通过 |
| `0.2.0-rc.1` | 通过 |
| `0.2.0-rc.2` | 通过 |
| `0.2.1-alpha.1` | 通过 |
| `0.2.1-alpha.2` | 通过 |
| `0.2.1-alpha.3` | 通过 |
| `0.2.1-alpha.4` | 通过 |
| `0.2.1-alpha.5` | 通过 |
| `0.2.1-rc.1` | 通过 |
| `0.2.1-rc.2` | 通过 |
| `0.2.1-rc.3` | 通过 |
| `0.2.1-rc.4` | 通过 |
| `0.2.1-rc.5` | 通过 |
| `0.2.2-alpha.2` | 通过 |

## 真实浏览器

- `0.1.5-alpha.1`：设置 → 插件配置，默认折叠网络设置卡片；编辑并保存 User-Agent，确认独立文件修订号增加。
- `0.2.2-alpha.2`：插件列表 → 本插件详情，原生 bundle 配置槽位显示同一模板；编辑并保存成功；端口为 0 时显示宿主校验错误且保留草稿。
- 浏览器验收覆盖上述新旧入口代表版本。其余版本执行真实启动和 HTTP 功能验收，未逐版人工操作浏览器。

实际启动还发现并修复 loader 的 profile 定位：优先读取实际 Cordis 插件上下文 `baseUrl`，随后读取 loader context，保留显式 profileDir。新增回归测试避免再次只模拟 loader.config.baseUrl。

## 复测

先构建相邻的 `../dsh-loader`，安装本插件开发依赖并执行 `npm test`，再运行：

```sh
node scripts/prepare-launch.mjs --alpha1-app-boot-pin
node scripts/test-launch.mjs
# 单版，保留给真实浏览器；终端输入回车结束
node scripts/test-launch.mjs --version=0.2.2-alpha.2 --keep
```

prepare 使用官方 npm 包及 peer 解析，各版独立安装。可通过 PNPM_CLI 指定 pnpm JS 入口。`--keep` 的带认证浏览器地址只写到 `.cache/launch/active.json`，不进入提交的验收记录。
