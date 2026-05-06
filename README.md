# Hermes Browser Bridge

A local proxy + WebSocket bridge that gives the **Hermes Agent** (an AI assistant) full read and control of your live browser tab — bypassing Cloudflare, CORS, and login walls by operating inside your authenticated browser session.

```
Browser Tab                    Extension               Proxy Server            Hermes Agent
┌──────────┐    WebSocket     ┌──────────┐    HTTP     ┌──────────┐    REST     ┌──────────┐
│ content  │ ◄──────────────► │ backgr.  │ ◄─────────► │ proxy    │ ◄─────────► │ Hermes   │
│ DOM read │    mutations     │ WS client│  commands   │ WS+HTTP  │  page state │ Agent    │
│ cmd exec │    snapshots     │ router   │             │ mirror   │  commands   │          │
└──────────┘                  └──────────┘             └──────────┘             └──────────┘
```

## Quick Start

```bash
# 1. Start the proxy server
cd proxy_server && npm install && npm start

# 2. Load the extension in your browser
# Safari: Open extension_safari.safariextension/ in Safari → Develop → Allow Unsigned Extensions
# Chrome: Go to chrome://extensions → Developer mode → Load unpacked → extension_chrome/

# 3. Open a web page and click the extension icon → "Activate Tab"
```

For detailed setup instructions including Safari developer mode and certificate setup, see [SETUP.md](SETUP.md).

## Architecture

| Module | Purpose |
|--------|---------|
| `proxy_server/` | Node.js HTTP/WebSocket proxy (port 9321) — page state cache, command routing, metrics |
| `extension_shared/` | Shared content script logic used by both Chrome and Safari extensions |
| `extension_chrome/` | Chrome Manifest V3 extension (service worker + popup + content script) |
| `extension_safari/` | Safari Web Extension (native Swift handler + background + popup + content) |
| `launchd/` | macOS auto-start plist for login-persistent proxy |
| `certificates/` | CA certificate generation for HTTPS mode |
| `scripts/` | Build helpers (cert generation) |
| `tests/` | Smoke tests (curl + Playwright) |

## API

The proxy exposes a REST API on `http://localhost:9321`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Status, version, connected extensions |
| GET | `/page_state` | Current page DOM, URL, title |
| POST | `/command` | Execute command (click, type, scroll, navigate, evaluate) |
| GET | `/sessions` | List active browser sessions |
| GET | `/metrics` | Prometheus-formatted metrics |
| GET | `/dashboard` | HTML dashboard of all sessions |

WebSocket endpoints:
- `/` — Extension connection (page snapshots, mutations, command acks)
- `/hermes` — Hermes Agent push subscription

## Requirements

- Node.js >= 18
- macOS (for Safari extension and launchd)
- Chrome or Safari browser

## Version

**1.3.2** — See [CHANGELOG.md](CHANGELOG.md) for full history.

## License

MIT
