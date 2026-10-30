# dsh-network-settings 2.0.0

User-Agent rewriting, HTTP / CONNECT / SOCKS5 proxying, and request retries for dsh. Requires **dsh-loader ^2.0.0** and **Node.js >=24.9.0**.

The loader renders a declarative template as one collapsed Network card with User-Agent, proxy, and retry groups. Save, cancel, and restore-defaults apply to the whole card. Saved changes affect the next outgoing request.

Before `0.1.6-alpha.2`, open Settings → Plugin configuration. On newer versions, open this plugin's detail page. Configuration lives at `<profile>/config/dsh-network-settings/config.json`; password values stay opaque in browser responses and revision conflicts preserve drafts.

The proxy supports authentication, NO_PROXY, timeouts, redirects and compressed responses. Retries cover network failures and 429/500/502/503/504; cancellation and non-replayable streams are never retried. Unload releases this plugin's fetch layer while preserving later wrappers.

The old custom UI and settings write route have been removed. Composition values and the legacy `$DSH_HOME/net-proxy.json` seed defaults; saved profile configuration takes precedence. Old settings namespaces are not moved automatically. Record custom namespace values before upgrading and save them through the new form.

The authenticated `/_dsh/dsh-network-settings/probe` endpoint remains available (GET health check, POST connectivity probe). Declarative templates have no custom action button, so this version does not include the old custom Test Connection button.

The local development dependency points at the adjacent `../dsh-loader` 2.0 workspace. Build it first, then run `npm install --legacy-peer-deps`, `npm run typecheck`, `npm test`, and `npm pack --dry-run` here.

See [中文说明](README.zh_CN.md) and the [real launch verification record](docs/testing-2.0.md). The latter documents the upstream dependency pin required by `0.1.6-alpha.1`.

MIT License.
