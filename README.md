# @dsh-plugin/dsh-network-settings

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that bundles three network capabilities — **User-Agent rewriting** (from [@dsh-plugin/dsh-user-agent](https://github.com/dsh-plugins/dsh-user-agent)), a **HTTP / HTTPS-CONNECT / SOCKS5 proxy** (from [dsh-net-proxy](https://github.com/mafeis/dsh-net-proxy)), and **configurable request auto-retry** — all driven from a single **网络设置 (Network)** tab in the Web settings.

## Features

- **User-Agent rewriting** — force a custom `User-Agent` on every outgoing request that uses global `fetch` (LLM API calls from `dsh-llm-deepseek`, web search, HTTP tools, …), overriding the caller's own header. Toggle on/off, edit the string, applies to the very next request.
- **Network proxy** — route the agent's network requests through an HTTP (CONNECT tunnel) or SOCKS5 proxy, with optional username/password, `NO_PROXY` direct-connection list (host / suffix / `host:port` / IPv4 CIDR / `*` / `<local>`), and a request timeout. A **测试连接 (Test connection)** button runs a real connectivity + latency probe (proxy TCP handshake, total round-trip, target HTTP status) from the settings page.
- **Request auto-retry** — configure the **maximum request retry count** (0 = off): when an outbound request fails with a network-layer error (undici connect/timeout/reset codes) or a retryable status (`429`, `500`, `502`, `503`, `504`), it is retried automatically with bounded exponential backoff (500 ms base, 10 s cap) + 10% jitter. Aborts (user cancellation) and non-replayable streaming bodies are never retried; the request body is replayed only when it is replayable (string / URLSearchParams / ArrayBuffer / Blob / FormData).
- **One settings tab, three independent sections** — the UA, proxy, and retry sections each have their own **保存 (Save)** button; changes are applied live on the next request without a restart. All values live in the standard `dsh-network-settings` user-settings namespace.
- **Clean lifecycle** — `globalThis.fetch` is wrapped only while the plugin runs; the original fetch is captured once and restored on stop / update / removal.
- **Same-origin probe route** — `/_dsh/dsh-network-settings/probe` performs the proxy connectivity test (read-only, never writes config).

## Install

The package is a [dsh bundle plugin](https://github.com/dsh-plugins) (`dsh.bundle.patch`), installable with the standard `dsh plugin add` command:

```bash
dsh plugin add @dsh-plugin/dsh-network-settings
# or, with a specific profile
dsh plugin --profile web add @dsh-plugin/dsh-network-settings
```

Then open **Settings → 网络设置** in the Web GUI: edit any of the three sections and hit its **保存** button.

### Replacing the old plugins

This plugin supersedes both `@dsh-plugin/dsh-user-agent` and `dsh-net-proxy` (it implements their full functionality). Remove them from the profile once installed:

```bash
dsh plugin remove @dsh-plugin/dsh-user-agent
dsh plugin remove net-proxy
```

Existing data is migrated automatically: if the old `~/.dsh/net-proxy.json` (or `$DSH_HOME/net-proxy.json`) exists, its proxy fields are merged into the plugin's base layer on startup (values you save in the 网络设置 tab always win).

## Configuration

Plugin entry (`cordis.patch.yml` / profile override) — the values act as the composition `base` layer and are merged with the user-settings section:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `uaEnabled` | `boolean` | `true` | UA rewriting master switch; when off the caller's User-Agent passes through. |
| `userAgent` | `string` | `DeepSeek-Harness/0.1 (+https://github.com/deepseek-ai/dsh)` | The User-Agent applied to every rewritten request. |
| `proxyEnabled` | `boolean` | `false` | Proxy master switch; when off requests go direct. |
| `proxyProtocol` | `string` | `http` | Proxy protocol: `http` (CONNECT tunnel) or `socks5`. |
| `proxyHost` | `string` | `127.0.0.1` | Proxy address. |
| `proxyPort` | `number` | `7890` | Proxy port. |
| `proxyUsername` | `string` | `''` | Optional proxy username. |
| `proxyPassword` | `string` | `''` | Optional proxy password. |
| `proxyNoProxy` | `string[]` | `['127.0.0.1','localhost','::1']` | Direct-connection host list; matched requests bypass the proxy. |
| `proxyTimeoutMs` | `number` | `60000` | Proxy request timeout in ms. |
| `retryEnabled` | `boolean` | `true` | Auto-retry master switch. |
| `maxRetries` | `number` | `2` | Maximum request retry count (0 = no retries). |

## How it works

- The host half installs the `dsh-network-settings` settings namespace (`installSettingsSection`) and wraps `globalThis.fetch` once with a three-layer stack, read per request:
  `retry → User-Agent rewrite → proxy → original fetch`. Each attempt of a retried request re-reads the latest resolved config, so saved changes apply to the very next request.
- The proxy engine is the ported dsh-net-proxy implementation (HTTP absolute-URL forwarding, HTTPS via CONNECT, SOCKS5 negotiation with RFC 1929 auth, streaming response bodies with gzip / br / deflate decoding, HTTP/2 via ALPN, redirect following, NO_PROXY matching).
- The browser half registers the `settings.section` tab and reads/writes the namespace through the connection's ApiProxy (`api.settings.describe` / `update`), the same seam the aux/mainline DSH plugins use; the proxy connectivity test goes through the same-origin probe route.

## Development

```bash
npm install          # dev deps + auto-installed peers
npm run build        # tsc (host + client) + strip client module-ification artifact
npm test             # node --test (TypeScript tests run natively on Node ≥ 23.6)
npm pack --dry-run   # inspect published contents
```

All source — host, proxy engine, settings UI, and tests — is TypeScript.

## License

MIT