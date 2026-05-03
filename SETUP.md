# Hermes Browser Bridge — Setup Guide

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

## Step 2: Generate Extension Icons

The extension needs PNG icon files. Generate them:

```bash
cd ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/extension_safari/Contents/Resources/images
node generate_icons.js
```

Expected output:
```
Created icon-16.png (243 bytes)
Created icon-48.png (945 bytes)
Created icon-96.png (1739 bytes)
Created icon-128.png (2864 bytes)
```

---

## Step 3: Load the Safari Extension

macOS Safari allows loading unpacked Web Extensions directly from the filesystem. No App Store, no bundling.

**Via the Develop menu (fastest):**

```
1. Safari → Develop menu → "Extensions…"
2. Click the "+" button at the bottom of the Extensions list
3. Navigate to: ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/extension_safari
4. Click "Open"
5. Safari prompts: "Develop extension?" → Click "Install"
```

**Via Settings (alternative):**

```
1. Safari → Settings… → Privacy & Security
2. Scroll to "Extensions"
3. Click "Install…" (or click "+" if available)
4. Navigate to: ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/extension_safari
5. Click "Open"
```

If you see "Failed to load" — Developer mode is not enabled. Repeat Step 1.

**Verify the extension loaded:**
- Look for the 🔷 icon in Safari's toolbar (right side of address bar)
- If no icon: right-click the address bar → Customize Control Strip → drag "Hermes Browser Bridge" to visible area

---

## Step 4: Start the Proxy Server

Open a Terminal window and run:

```bash
cd ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/proxy_server
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

## Step 5: Activate the Extension in Safari

```
1. Browse to any website in Safari (e.g. https://sonniss.com)
2. Click the 🔷 Hermes Browser Bridge icon in the toolbar
3. Click "Activate Tab"
4. Status changes to "Connected" (green dot)
5. Current tab URL appears in the popup
```

The extension is now streaming your tab to the proxy server.

---

## Step 6: Test the Proxy API

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

## Step 7: Done — Use with Hermes Agent

Once running, just tell me: "Read my Safari tab" or "click the login button" or "scroll down on my current page." I will query the proxy automatically.

---

## Troubleshooting

### Extension shows "Error" state

1. Proxy server not running → `cd ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/proxy_server && node server.js`
2. Wrong working directory → must be inside the `proxy_server` folder

### Extension shows "Connecting…" forever

WebSocket cannot reach the proxy:
- Proxy server not running → start it (Step 4)
- Wrong directory → `cd ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/proxy_server && node server.js`
- Port conflict → `lsof -ti :9321 | xargs kill -9` then restart

### "Failed to load" when installing extension

- Safari Developer mode not enabled → Step 1
- Extension files missing → run:
  ```bash
  find ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/extension_safari -type f | wc -l
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
| Start proxy | `node ~/Desktop/DEVPROJECTS/mmorgp_browser_bridge/proxy_server/server.js` |
| Stop proxy | Ctrl+C in the proxy Terminal |
| Health | `curl http://localhost:9321/health` |
| Page state | `curl http://localhost:9321/health` |
| Kill port | `lsof -ti :9321 \| xargs kill -9` |

---

## Project Structure

```
mmorgp_browser_bridge/
├── extension_safari/
│   ├── Contents/
│   │   ├── Info.plist
│   │   └── Resources/
│   │       ├── manifest.json      ← Manifest V3
│   │       ├── background.js      ← WebSocket client
│   │       ├── content.js         ← DOM reader + cmd executor
│   │       ├── popup.html/css/js  ← Click-to-activate UI
│   │       ├── _locales/
│   │       └── images/            ← Extension icons
├── proxy_server/
│   ├── server.js                  ← HTTP + WebSocket proxy
│   ├── page_mirror.js            ← DOM cache
│   ├── cmd_queue.js              ← Command tracking
│   └── package.json               ← ws@^8.20.0
├── certificates/
│   ├── ca.crt                    ← Self-signed CA (optional, v1 not needed)
│   └── README.md
├── SPEC.md                        ← Architecture spec
└── SETUP.md                       ← This file
```
