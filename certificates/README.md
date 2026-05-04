# CA Certificate Installation — macOS Keychain

This guide explains how to install the Hermes Browser Bridge CA certificate so the proxy can inspect HTTPS traffic. For v1 the proxy runs over plain HTTP on localhost — HTTPS inspection is only needed if you expose the proxy outside localhost or want TLS-wrapped WebSocket.

## Should you install this?

**Default v1 setup: NO.** The proxy uses plain `ws://localhost:9321` (unencrypted WebSocket). No TLS needed for localhost traffic — nothing leaves your machine.

**Install the CA only if:**
- You expose the proxy over your LAN or the internet
- You want TLS-wrapped WebSocket (`wss://`) in production
- A site refuses to communicate over an insecure WebSocket

---

## How to generate the CA certificate

Run the certificate generation script:

```bash
./scripts/generate-certs.sh
```

You will be prompted for a password to encrypt the CA private key. **Do not lose this password** — it is required to start the proxy in HTTPS mode.

---

## How to install the CA certificate (if needed)

### Step 1: Add to Keychain

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Desktop/DEVPROJECTS/hermes-browser-bridge/certificates/ca.crt
```

Or manually:
1. Open **Keychain Access** (search in Spotlight)
2. Click **System** in the left sidebar
3. Drag `ca.crt` into the Keychain Access window
4. Expand the certificate, click **Trust**, set to **Always Trust**
5. Authenticate with your Mac password

### Step 2: Verify the CA cert (optional)

```bash
# Verify the CA is correctly formed and has the expected properties
openssl x509 -in ~/Desktop/DEVPROJECTS/hermes-browser-bridge/certificates/ca.crt -text -noout | head -20
```

Apple may reset CA trust after a macOS update. Re-run the command above after updates.

---

## CA key security

**Fix #2**: The CA key (`ca.key`) is now AES-256 encrypted. It is protected by the password you entered during `generate-certs.sh`.

### Storing the password

1. Create a `.env` file in the `proxy_server/` directory:
   ```bash
   echo 'HBS_CA_KEY_PASSWORD=<your-password>' >> proxy_server/.env
   ```

2. The proxy reads `HBS_CA_KEY_PASSWORD` from the environment to decrypt the key at startup.

**Important**: Never commit `ca.key` or `.env` to version control.

---

## Production readiness notes

For a production deployment, you would:

1. **TLS on the proxy**: Wrap the WebSocket server with TLS using `ca.crt` + a server cert signed by the CA
2. **Authentication**: Add a hardcoded Bearer token to both the REST API and WebSocket handshake
3. **CA key security**: Store `ca.key` in your macOS Keychain or a secrets manager, never in the repo
4. **Certificate pinning**: Pin the CA in the extension for extra security

These are out of v1 scope but documented here for future development.
