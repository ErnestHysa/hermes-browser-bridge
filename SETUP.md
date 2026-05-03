# Hermes Browser Bridge — Setup Guide v1.3.0

**For macOS (Apple Silicon/Intel) · Safari · Node.js v18+**

This guide takes you from zero to fully running in under 10 minutes.

---

## Prerequisites

- macOS 13+ (Ventura, Sonoma, or Sequoia)
- Safari with Developer mode enabled
- Node.js v18+ (`node --version`)
- Xcode command line tools (`xcode-select --install` — does nothing if already installed)

---

## Step 1: Enable Safari Developer Mode

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

---

## Step 2: Compile the Native Extension Handler

The Safari extension requires a native binary (`SafariWebExtensionHandler`) to bridge JavaScript and Safari.

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge
swiftc \
  -target arm64-apple-macosx13.0 \
  -sdk $(xcrun --sdk macosx --show-sdk-path) \
  extension_safari/Contents/MacOS/SafariWebExtensionHandler.swift \
  -o extension_safari/Contents/MacOS/SafariWebExtensionHandler
```

Expected: **no output** (success). A warning about unused `profile` is harmless.

If you see `error: cannot find 'SafariServices'` — run:
```bash
xcode-select --install
```

---

## Step 3: Generate Extension Icons (optional — already done)

Icons are pre-generated. To regenerate:

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari/Contents/Resources/images
node generate_icons.js
```

---

## Step 4: Load the Safari Extension

macOS Safari allows loading unpacked Web Extensions directly from the filesystem. No App Store, no bundling.

**Via the Develop menu (fastest):**

```
1. Safari → Develop menu → "Extensions…"
2. Click the "+" button at the bottom of the Extensions list
3. Navigate to: ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari
4. Click "Open"
5. Safari prompts: "Develop extension?" → Click "Install"
```

**Via Settings (alternative):**

```
1. Safari → Settings… → Privacy & Security
2. Scroll to "Extensions"
3. Click "Install…" (or click "+" if available)
4. Navigate to: ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari
5. Click "Open"
```

If you see "Failed to load" — Developer mode is not enabled. Repeat Step 1.

**Verify the extension loaded:**
- Look for the Hermes Browser Bridge icon in Safari's toolbar (right side of the address bar)
- If no icon: right-click the address bar → Customize Control Strip → drag "Hermes Browser Bridge" to visible area

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

## Step 6: (Optional) HTTPS Proxy

For accessing the proxy from other machines on your network, use the HTTPS variant instead:

```bash
cd ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server
node server_https.js
```

Runs on `https://localhost:9322`. You must first install the CA cert:
```bash
# See certificates/README.md for full instructions
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/Desktop/DEVPROJECTS/hermes-browser-bridge/certificates/ca.crt
```

---

## Step 7: Start the Proxy Server

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

## Step 8: Activate the Extension in Safari

```
1. Browse to any website in Safari (e.g. https://example.com)
2. Click the Hermes Browser Bridge icon in the toolbar
3. Click "Activate Tab"
4. Status changes to "Connected" (green dot)
5. Current tab URL appears in the popup
```

The extension is now streaming your tab to the proxy server.

---

## Step 9: Test the Proxy API

Open a second Terminal window (proxy keeps running in the first):

```bash
# Check proxy health
curl http://localhost:9321/health

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

# Poll a command result
curl http://localhost:9321/command/<cmdId>
```

---

## Step 10: Done — Use with Hermes Agent

Once running, just tell me: "Read my Safari tab" or "click the login button" or "scroll down on my current page." I will query the proxy automatically.

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
- Extension files missing → run:
  ```bash
  find ~/Desktop/DEVPROJECTS/hermes-browser-bridge/extension_safari -type f | wc -l
  ```
  Should output 13 or more.

### Extension icon not in toolbar

- Right-click address bar → Customize Control Strip → find "Hermes Browser Bridge" → drag to visible area

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
| Start HTTPS proxy | `node ~/Desktop/DEVPROJECTS/hermes-browser-bridge/proxy_server/server_https.js` |
| Stop proxy | Ctrl+C in the proxy Terminal |
| Health | `curl http://localhost:9321/health` |
| Page state | `curl http://localhost:9321/page_state` |
| Kill port | `lsof -ti :9321 \| xargs kill -9` |
| Install auto-start | `cp launchd/*.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.hermes-agent.browser-bridge.plist` |

---

## Project Structure

```
hermes-browser-bridge/
├── proxy_server/
│   ├── server.js           ← HTTP + WebSocket proxy (main entry)
│   ├── server_https.js     ← HTTPS + WSS variant (optional)
│   ├── page_mirror.js      ← DOM cache + mutation ring buffer
│   ├── cmd_queue.js        ← Command queue with timeout + ack/error tracking
│   └── package.json        ← ws@^8.20.0
├── extension_safari/
│   ├── Contents/
│   │   ├── Info.plist
│   │   ├── MacOS/
│   │   │   ├── SafariWebExtensionHandler    ← Compiled native binary
│   │   │   └── SafariWebExtensionHandler.swift
│   │   └── Resources/
│   │       ├── manifest.json   ← Manifest V3
│   │       ├── background.js  ← WebSocket client + message routing
│   │       ├── content.js     ← MutationObserver, DOM reader, cmd executor
│   │       ├── popup.html/css/js  ← Click-to-activate popup UI
│   │       ├── _locales/
│   │       └── images/        ← Extension icons
├── launchd/
│   └── com.hermes-agent.browser-bridge.plist  ← Auto-restart on login
├── certificates/
│   ├── ca.crt / ca.key      ← Self-signed CA (for HTTPS variant)
│   └── README.md
├── SPEC.md                        ← Architecture spec
├── SETUP.md                       ← Setup guide
└── CHANGELOG.md                   ← Version history
```
