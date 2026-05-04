#!/usr/bin/env bash
# =============================================================================
# generate-certs.sh — Generate self-signed CA certificates for HTTPS mode.
#
# Fix #21: Created to document and automate HTTPS cert setup. The proxy requires
# certificates/ directory to contain ca.crt + ca.key in order to start in
# --https mode. Run this script once to generate them.
#
# Usage:
#   ./scripts/generate-certs.sh
#
# Output:
#   certificates/ca.crt   — CA certificate (install into macOS Keychain)
#   certificates/ca.key   — CA private key (keep secret)
#
# After installing ca.crt into Keychain, browsers will trust the proxy cert.
# =============================================================================

set -euo pipefail

CERTS_DIR="$(cd "$(dirname "$0")/../certificates" && pwd)"
mkdir -p "$CERTS_DIR"

echo "=== Hermes Browser Bridge — Self-Signed CA Certificate Generator ==="
echo ""
echo "Output directory: $CERTS_DIR"
echo ""

# Prompt for CA key password (with visual feedback via stty)
read -r -p "Enter a password to encrypt the CA private key: " CA_KEY_PASSWORD
if [[ -z "$CA_KEY_PASSWORD" ]]; then
  echo "ERROR: Password cannot be empty."
  exit 1
fi

# Generate a 2048-bit RSA CA key + self-signed certificate
# Fix #2: Key is now encrypted with AES-256-CBC instead of being stored unencrypted (-nodes removed)
openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERTS_DIR/ca.key" \
  -out "$CERTS_DIR/ca.crt" \
  -days 3650 \
  -passout pass:"$CA_KEY_PASSWORD" \
  -aes256 \
  -subj "/CN=Hermes Browser Bridge CA/O=Hermes Agent/C=US" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo ""
echo "✓ Certificates generated:"
echo "  $CERTS_DIR/ca.crt"
echo "  $CERTS_DIR/ca.key  (AES-256 encrypted, password protected)"
echo ""
echo "IMPORTANT: Keep the password safe — it is needed to start the proxy."
echo ""
echo "Next steps:"
echo "  1. Install the CA cert into macOS Keychain:"
echo "       sudo security add-trusted-cert -d -r trustRoot \\"
echo "         -k /Library/Keychains/System.keychain \\"
echo "         $CERTS_DIR/ca.crt"
echo ""
echo "  2. Create .env file with the CA key password:"
echo "       echo 'HBS_CA_KEY_PASSWORD=<your-password>' >> proxy_server/.env"
echo ""
echo "  3. Start proxy in HTTPS mode:"
echo "       cd proxy_server && npm run start:https"
