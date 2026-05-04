# Hermes Browser Bridge — Setup Guide v1.3.0

**For macOS (Apple Silicon/Intel) · Safari & Chrome · Node.js v18+**

This guide takes you from zero to fully running in under 10 minutes.

---

## Prerequisites

- macOS 13+ (Ventura, Sonoma, or Sequoia)
- Safari with Developer mode enabled **or** Chrome with Developer mode enabled
- Node.js v18+ (`node --version`)
- Xcode command line tools (`xcode-select --install` — does nothing if already installed)

---

## Step 1: Build the Native Binary and Icons

Before loading the extension, compile the Safari native handler and generate icons:

**Icons are pre-generated and committed to the repo** — you do not need to regenerate them unless you change the design. If you do change the design, run `npm run build:icons` from `proxy_server/` to regenerate all sizes from a source image.

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server

# Compile Safari's native extension handler (required for Safari)
npm run build:safari

# Generate all icon sizes — only needed if you change the icon design
# (requires a source image at ../extension_safari/Contents/Resources/images/source.png)
npm run build:icons

# Or run both at once:
npm run build:all
```

**Safari requires a `.safariextension` bundle** for sideloading. After cloning the repo, run:

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge
# Create the .safariextension bundle as a symlink to extension_safari
ln -s extension_safari extension_safari.safariextension
```

The `.safariextension` directory is gitignored — it is a development-time symlink. The source of truth is `extension_safari/`.

Expected: **no output** (success). A warning about unused `profile` parameter in `SafariWebExtensionHandler.swift` is harmless.

If you see `error: cannot find 'SafariServices'` — run:
```bash
xcode-select --install
```

---

## Step 2: Enable Browser Developer Mode

### Safari

Required to load the extension without App Store distribution.

```
1. Open Safari
2. Safari menu → Settings… → Advanced (tab)
3. ✅ Check "Show Develop menu in menu bar"
4. Close Settings
5. Safari menu → Settings… → Privacy & Security
6. Scroll down to "Extensions"
7. ✅ Check "Allow extension installation from developers"
```

The **Develop** menu now appears in your menu bar.

### Chrome

```
1. Go to chrome://extensions/
2. Enable **Developer mode** (toggle in top right corner)
```

---

## Step 3: Load the Browser Extension

### Safari

macOS Safari allows loading unpacked Web Extensions directly from the filesystem. No App Store, no bundling.

**Via the Develop menu (fastest):**

```
1. Safari → Develop menu → "Extensions…"
2. Click the "+" button at the bottom of the Extensions list
3. Navigate to: ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari.safariextension
4. Click "Open"
5. Safari prompts: "Develop extension?" → Click "Install"
```

**Via Settings (alternative):**

```
1. Safari → Settings… → Privacy & Security
2. Scroll to "Extensions"
3. Click "Install…" (or click "+" if available)
4. Navigate to: ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari.safariextension
5. Click "Open"
```

**Verify the extension loaded:**
- Look for the Hermes Browser Bridge icon in Safari's toolbar (right side of the address bar)
- If no icon: right-click the address bar → Customize Control Strip → drag "Hermes Browser Bridge" to visible area

### Chrome

```
1. Go to chrome://extensions/
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the directory: ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_chrome
5. The Hermes Browser Bridge icon appears in Chrome's toolbar
```

---

## Step 4: Start the Proxy Server

Open a Terminal window and run:

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server
node server.js
```

Expected output:
```
Hermes Browser Bridge proxy running
  HTTP REST: http://localhost:9321
  WebSocket: ws://localhost:9321

Waiting for extension to connect…
```

**Keep this Terminal window open** — the proxy keeps running.

If you see `ERROR: Port 9321 is already in use.`:
```bash
lsof -ti :9321 | xargs kill -9
node server.js
```

---

## Step 5: (Optional) Auto-Start with Launchd

Install the launchd plist to have the proxy start automatically on login and restart after crashes:

```bash
cp ~/Desktop/DEVPROJECTS/hermes-browser-bridge/launchd/com.hermes-agent.browser-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hermes-agent.browser-bridge.plist
```

Verify it's running:
```bash
launchctl list | grep hermes
curl http://localhost:9321/health
```

To uninstall:
```bash
launchctl unload ~/Library/LaunchAgents/com.hermes-agent.browser-bridge.plist
rm ~/Library/LaunchAgents/com.hermes-agent.browser-bridge.plist
```

---

## Step 6: Activate the Extension in Your Browser

### Safari

```
1. Browse to any website in Safari (e.g. https://example.com)
2. Click the Hermes Browser Bridge icon in the toolbar
3. Click "Activate Tab"
4. Status changes to "Connected" (green dot)
5. Current tab URL appears in the popup
```

### Chrome

```
1. Browse to any website in Chrome
2. Click the Hermes Browser Bridge icon in Chrome's toolbar
3. Click "Activate Tab"
4. Status changes to "Connected" (green dot)
5. Current tab URL appears in the popup
```

The extension is now streaming your tab to the proxy server.

---

## Step 7: Test the Proxy API

Open a second Terminal window (proxy keeps running in the first):

```bash
# Check proxy health
curl http://localhost:9321/health

# List all active sessions
curl http://localhost:9321/sessions

# Get current page state (full HTML of your tab)
curl http://localhost:9321/page_state

# Send a scroll command
curl -X POST http://localhost:9321/command \
  -H "Content-Type: application/json" \
  -d '{"type":"scroll","x":0,"y":500}'

# Send a click command (clicks the body element)
curl -X POST http://localhost:9321/command \
  -H "Content-Type: application/json" \
  -d '{"type":"click","selector":"body"}'

# Send a type command
curl -X POST http://localhost:9321/command \
  -H "Content-Type: application/json" \
  -d '{"type":"type","selector":"input","text":"hello"}'

# Navigate to a URL
curl -X POST http://localhost:9321/command \
  -H "Content-Type: application/json" \
  -d '{"type":"navigate","url":"https://example.com"}'

# Cancel a pending command
curl -X DELETE http://localhost:9321/command/<cmdId>

# Poll a command result
curl http://localhost:9321/command/<cmdId>

# Prometheus metrics
curl http://localhost:9321/metrics
```

---

## Step 8: (Optional) HTTPS Proxy

For accessing the proxy from other machines on your network (e.g., a second Mac on the same LAN), use the `--https` flag:

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server
node server.js --https
```

Runs on `https://localhost:9322`. Before using HTTPS, install the CA cert so your browser trusts the proxy's TLS certificate:

```bash
# Generate a local CA + server cert if you haven't already:
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge
mkdir -p certificates
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout certificates/ca.key -out certificates/ca.crt \
  -days 397 -subj "/CN=HermesBrowserBridge CA" -nodes

# Install the CA cert as trusted (requires sudo for system keychain):
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/Desktop/DEVPROJECTS/hermes-browser-bridge/certificates/ca.crt

# For macOS Sonoma 14+ you may also need:
sudo security add-trusted-cert -d -r trustAsRoot \
  -k /Library/Keychains/System.keychain \
  ~/Desktop/DEVPROJECTS/hermes-browser-bridge/certificates/ca.crt
```

After installing the CA cert, point your browser to `https://localhost:9322` instead of `http://localhost:9321`.

> **Security note for production:** The CA cert approach is fine for personal/local use. For multi-user or internet-facing deployments, use ACME (Let's Encrypt) certificates or a proper PKI. The HTTPS variant also supports serving a valid cert from Let's Encrypt or another CA — just replace the cert/key paths in `server_https.js`.

> **End-to-end encryption (future):** When the proxy is accessed over a network instead of localhost, add a pre-shared key (HMAC) or TLS mTLS so traffic cannot be intercepted in transit. This is on the roadmap as `encryptedTransport` in SPEC.md.

---

## Step 9: Done — Use with Hermes Agent

Once running, just tell me: **"Read my browser tab"** or **"click the login button"** or **"scroll down on my current page."** I will query the proxy automatically.

---

## Troubleshooting

### Extension shows "Error" state
1. Proxy server not running → `cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server && node server.js`
2. Wrong working directory → must be inside the `proxy_server` folder

### Extension shows "Connecting…" forever
WebSocket cannot reach the proxy:
- Proxy server not running → start it (Step 4)
- Wrong directory → `cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server && node server.js`
- Port conflict → `lsof -ti :9321 | xargs kill -9` then restart

### "Failed to load" when installing extension
- Safari Developer mode not enabled → Step 1
- Chrome Developer mode not enabled → Step 2
- Extension files missing:
  ```bash
  find ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari -type f | wc -l
  ```
  Should output 14 or more.

### Extension icon not in toolbar
**Safari**: Right-click address bar → Customize Control Strip → find "Hermes Browser Bridge" → drag to visible area
**Chrome**: Click the puzzle piece icon in Chrome's toolbar → find "Hermes Browser Bridge" → pin it

### Page state returns empty html
- Extension activated but first snapshot hasn't arrived → wait 2 seconds and retry
- Check the popup showed "Connected" (green dot)

### Commands not working on a site
- Some sites (Google, banking, crypto) block content script injection via CSP
- This is a browser security policy — we cannot override it
- The extension still reads the page correctly, but interaction (click/type) may be blocked

---

## Quick Reference

| | |
|---|---|
| Start proxy | `node ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server/server.js` |
| Start HTTPS proxy | `node ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server/server.js --https` |
| Stop proxy | Ctrl+C in the proxy Terminal |
| Health | `curl http://localhost:9321/health` |
| Page state | `curl http://localhost:9321/page_state` |
| List sessions | `curl http://localhost:9321/sessions` |
| Prometheus metrics | `curl http://localhost:9321/metrics` |
| Kill port | `lsof -ti :9321 \| xargs kill -9` |
| Build Safari binary | `npm run build:safari` (in proxy_server/) |
| Generate icons | `npm run build:icons` (in proxy_server/) |
| Install auto-start | `cp launchd/*.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.hermes-agent.browser-bridge.plist` |

---

## Project Structure

```
hermes-browser-bridge/
├── proxy_server/
│   ├── server.js           ← HTTP + WebSocket proxy (main entry; --https flag for TLS)
│   ├── proxy_lib.js        ← Shared HTTP/WS logic, state management
│   ├── page_mirror.js      ← DOM cache + mutation ring buffer
│   ├── cmd_queue.js        ← Command queue with timeout + cancel support
│   ├── config.js           ← Runtime configuration (rates, sizes, timeouts)
│   └── package.json       ← ws@^8.20.0
├── extension_safari/
│   ├── Contents/
│   │   ├── Info.plist
│   │   ├── MacOS/
│   │   │   └── SafariWebExtensionHandler.swift  ← Source (compile with npm run build:safari)
│   │   └── Resources/
│   │       ├── manifest.json
│   │       ├── background.js
│   │       ├── content.js
│   │       ├── popup.html / popup.css / popup.js
│   │       ├── _locales/
│   │       └── images/
├── extension_chrome/          ← Chrome Manifest V3 extension
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html / popup.css / popup.js
│   └── images/
├── launchd/
│   └── com.hermes-agent.browser-bridge.plist  ← Auto-restart on login ($HOME-aware)
├── certificates/
│   ├── ca.crt / ca.key
│   └── README.md
├── SPEC.md
├── SETUP.md
├── AUTH.md
├── CHANGELOG.md
└── docs/
    └── CHROME_EXTENSION.md
```
