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

# Generate a 2048-bit RSA CA key + self-signed certificate
openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERTS_DIR/ca.key" \
  -out "$CERTS_DIR/ca.crt" \
  -days 3650 \
  -nodes \
  -subj "/CN=Hermes Browser Bridge CA/O=Hermes Agent/C=US" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo ""
echo "✓ Certificates generated:"
echo "  $CERTS_DIR/ca.crt"
echo "  $CERTS_DIR/ca.key"
echo ""
echo "Next steps:"
echo "  1. Install the CA cert into macOS Keychain:"
echo "       sudo security add-trusted-cert -d -r trustRoot \\"
echo "         -k /Library/Keychains/System.keychain \\"
echo "         $CERTS_DIR/ca.crt"
echo ""
echo "  2. Start proxy in HTTPS mode:"
echo "       cd proxy_server && npm run start:https"
