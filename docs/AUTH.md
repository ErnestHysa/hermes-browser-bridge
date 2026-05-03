# Production Authentication Design

**Version: v2.0 (not yet implemented)**

v1.3 of Hermes Browser Bridge intentionally ships **without authentication** — it assumes a trusted local machine with no hostile local users. This is correct for personal use on a single-user Mac.

This document describes what production readiness requires before exposing the proxy beyond localhost or sharing the machine.

---

## Threat Model

| Threat | v1.3 | v2.0 |
|---|---|---|
| Local unprivileged user reads page state | Not protected | Token required |
| Other browser sessions on same Mac | Not isolated | Per-session tokens |
| Network neighbors reaching proxy | Blocked by localhost | Token + mTLS |
| Malicious extension reading page state | Not protected | Extension signing |
| Replay attacks on commands | Not protected | Idempotency keys |
| Token theft | N/A | Keychain storage |
| Command injection via CSRF | Not protected | CSRF tokens |

---

## v2.0: Token-Based Auth

### Overview

```
Hermes Agent                    Browser Bridge Proxy              macOS Keychain
     │                                    │                              │
     │  POST /command                    │                              │
     │  Authorization: Bearer <token>   │                              │
     │ ─────────────────────────────────►│                              │
     │                                    │ Lookup keychain item         │
     │                                    │────────────────────────────► │
     │                                    │ ◄────────────────────────────│
     │                                    │ Validates token locally      │
     │                                    │ (no network call)            │
```

### Token Format

```json
{
  "token": "hbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "label": "hermes-browser-bridge",
  "created": 1747200000,
  "expires": 1759852800,
  "scope": ["read", "command"],
  "notBefore": 1747200000
}
```

- `hbs_` prefix identifies the token type
- 32-char random body (cryptographically random)
- Stored in macOS Keychain under the user's login keychain
- Never written to disk in plaintext
- 90-day expiry (configurable)

### Token Generation

```bash
# User generates a token (one-time setup)
node -e "
const crypto = require('crypto');
const token = 'hbs_' + crypto.randomBytes(24).toString('hex');
console.log(token);
// Store in Keychain:
require('child_process').execSync(
  'security add-generic-password -a hermes-browser-bridge -s hermes-bridge-token -w ' + token + ' -T /usr/bin/security',
  { stdio: 'inherit' }
);
"
```

### Proxy Startup (reads token from Keychain)

```javascript
// In proxy_lib.js — on startup
function loadTokenFromKeychain() {
  const result = child.spawnSync('security', [
    'find-generic-password',
    '-a', 'hermes-browser-bridge',
    '-s', 'hermes-bridge-token',
    '-w'  // output password to stdout
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error('Token not found in Keychain. Run: node scripts/setup_token.js');
  }
  return result.stdout.trim();
}

const VALID_TOKEN = loadTokenFromKeychain();

// On every HTTP request:
function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return { error: 'unauthorized', message: 'Missing Authorization header' };
  }
  const token = auth.slice(7);
  if (token !== VALID_TOKEN) {
    return { error: 'forbidden', message: 'Invalid token' };
  }
  return { ok: true };
}
```

### WebSocket Auth

The proxy validates the token on the first WebSocket message:

```javascript
// In proxy_lib.js — on WebSocket connection
wss.on('connection', (ws, req) => {
  // For WS, token comes in the first JSON message
  ws.once('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.token !== VALID_TOKEN) {
      ws.close(1008, 'Invalid token');
      return;
    }
    // Token valid — proceed with normal session setup
    setupSession(ws, msg);
  });
});
```

### Hermes Agent Side

```javascript
// In Hermes's browser_bridge tool / MCP server
const TOKEN = child.spawnSync('security', [
  'find-generic-password', '-a', 'hermes-browser-bridge',
  '-s', 'hermes-bridge-token', '-w'
], { encoding: 'utf8' }).stdout.trim();

async function command(cmd) {
  const res = await fetch('http://localhost:9321/command', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });
  return res.json();
}
```

---

## Idempotency Keys (Command Deduplication)

Network retries can cause the same command to execute twice. Idempotency keys prevent this.

### Request Format

```json
{
  "type": "click",
  "selector": "#submit-btn",
  "idempotencyKey": "uuid-v4-like-4b5x7q8r9s0t",
  "cmdId": "cmd_uuid"
}
```

### Proxy Behavior

```javascript
const seenKeys = new LRUCache(1000);  // Max 1000 keys in flight

function checkIdempotency(key) {
  if (seenKeys.has(key)) {
    return { duplicate: true, existingResult: seenKeys.get(key) };
  }
  return { duplicate: false };
}

function markCompleted(key, result) {
  seenKeys.set(key, result);
  setTimeout(() => seenKeys.delete(key), 60000); // Evict after 60s
}
```

---

## CSRF Protection

HTTP endpoints are vulnerable to cross-site request forgery if the browser has the token stored in Keychain and accessible to malicious pages.

### Mitigation: Origin Validation

```javascript
// Only allow requests from the local Hermes agent process
function checkOrigin(req) {
  // Hermes agent makes requests from its own process — check via a secret header
  const secret = req.headers['x-hermes-secret'];
  if (!secret || secret !== process.env.HERMES_SECRET) {
    return false;
  }
  return true;
}
```

---

## End-to-End Encryption (Future)

For users accessing their browser bridge over a network (not localhost), add TLS:

```bash
# Generate a client certificate
openssl req -new -x509 -keyout client.key -out client.crt -days 365

# Proxy server_https.js already supports TLS — add client cert verification:
const tlsOptions = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.crt'),
  requestCert: true,
  ca: fs.readFileSync('ca.crt')  // Only allow known client certs
};
```

With mutual TLS (mTLS), both the server and client authenticate each other with certificates. This replaces token-based auth entirely for network-exposed deployments.

---

## Extension Signing (Chrome Web Store / Safari App Store)

To distribute extensions beyond sideloading, each store requires code signing:

### macOS (Apple)

- Requires an Apple Developer ID account ($99/year)
- Safari extensions: sign the `.safariextz` bundle with `codesign`
- Notarization required for macOS 10.15+ (Gatekeeper)

### Chrome Web Store

- Requires a Chrome Web Store developer account ($5 one-time)
- Sign the ZIP with `chrome-webstore-upload` or the Chrome Developer Dashboard
- Manifest V3 required for new extensions

For personal sideloading (no store), signing is not required but Gatekeeper may warn on first run.

---

## Security Summary

| Layer | Protection |
|---|---|
| Transport | localhost-only by default; TLS for network exposure |
| Authentication | Bearer token from macOS Keychain |
| Authorization | Token scoped to read + command |
| Replay protection | Idempotency keys on commands |
| CSRF | Secret header + origin check |
| Extension isolation | activeTab permission; no cross-origin injection |
| Token storage | macOS Keychain (system-encrypted) |
| Future | mTLS client certificates |
