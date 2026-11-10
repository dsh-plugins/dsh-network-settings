# dsh-network-settings 2.0.0

User-Agent rewriting, HTTP / CONNECT / SOCKS5 proxying, response idle timeouts, and request retries for DSH. Requires **dsh-loader ^2.0.0** and **Node.js >=24.9.0**.

The loader renders one Network card for User-Agent, proxy, idle timeout, and retry settings. Save, cancel, and restore defaults apply to the whole card.

Before `0.1.6-alpha.2`, open Settings → Plugin configuration. On newer versions, open this plugin's detail page. Configuration lives at `<profile>/config/dsh-network-settings/config.json`; password values stay opaque in browser responses and revision conflicts preserve drafts.

`requestIdleTimeoutMs` defaults to 240 seconds. It limits the wait for response headers and the gap between chunks. A stream can run longer while data keeps arriving. The previous `proxyTimeoutMs` field controls proxy connection setup.

Saved changes apply to subsequent HTTP requests. The plugin reloads pi-ai after an idle timeout change and supplies the value as the default `streamIdleTimeoutMs` for HTTP and WebSocket model streams. Explicit provider settings keep their values. For HTTP streams, the first applicable idle timer to expire ends the request.

The proxy supports authentication, bypass rules, redirects, and compressed responses. An empty bypass list lets the plugin proxy handle all destinations. Requests with an explicit dispatcher keep the caller's transport settings. Replayable requests can retry on response-header timeouts, eligible network errors, and HTTP 429/500/502/503/504.

The old custom UI and settings write route have been removed. Composition values and the legacy `$DSH_HOME/net-proxy.json` seed defaults; saved profile configuration takes precedence. Old settings namespaces are not moved automatically. Record custom namespace values before upgrading and save them through the new form.

The authenticated `/_dsh/dsh-network-settings/probe` endpoint remains available (GET health check, POST connectivity probe). Declarative templates have no custom action button, so this version does not include the old custom Test Connection button.

The local development dependency points at the adjacent `../dsh-loader` 2.0 workspace. Build it first, then run `npm install --legacy-peer-deps`, `npm run typecheck`, `npm test`, and `npm pack --dry-run` here.

See [中文说明](README.zh_CN.md) and the [real launch verification record](docs/testing-2.0.md). The latter documents the upstream dependency pin required by `0.1.6-alpha.1`.

MIT License.
