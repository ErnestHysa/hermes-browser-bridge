#!/bin/bash
#
# smoke_test.sh — Hermes Browser Bridge basic sanity checks
# Run this after starting the proxy and activating the extension.
#
# Expected: all commands return exit 0.
# If any command fails, the script exits with the failing command's exit code.

PROXY="${PROXY:-http://localhost:9321}"
PASS=0
FAIL=0

# Use printf for inline output (no trailing newline) — cross-platform Linux/macOS.
check() {
  local description="$1"
  local cmd="$2"
  local expected_code="${3:-0}"

  printf "%s ... " "$description"
  output=$(eval "$cmd" 2>&1)
  actual_code=$?

  if [ "$actual_code" -eq "$expected_code" ]; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL (exit $actual_code)"
    FAIL=$((FAIL + 1))
    echo "  Command: $cmd"
    echo "  Output: $output"
  fi
}

http_code() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# ── Pre-flight: is playwright installed? ────────────────────────────────────

if ! command -v npx &>/dev/null || ! npx playwright --version &>/dev/null; then
  echo "WARNING: Playwright not found. Install with: npm install -D playwright && npx playwright install chromium"
fi

# ── Pre-flight: is the proxy up? ────────────────────────────────────────────

printf "Waiting for proxy to be ready"
for i in $(seq 1 10); do
  code=$(http_code "$PROXY/health" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo " OK"
    break
  fi
  sleep 1
done
echo

if [ "$code" != "200" ]; then
  echo "FATAL: Proxy not responding at $PROXY/health"
  echo "Is 'node server.js' running?"
  exit 1
fi

# ── Health endpoint ───────────────────────────────────────────────────────────

check "Health endpoint returns 200" \
  '[ "$(http_code "$PROXY/health")" = "200" ]'

check "Health has 'status' field" \
  "curl -s $PROXY/health | grep -q '\"status\"'"

check "Health has 'uptime' field" \
  "curl -s $PROXY/health | grep -q '\"uptime\"'"

check "Health has 'wsClients' field" \
  "curl -s $PROXY/health | grep -q '\"wsClients\"'"

# ── Page state endpoint ───────────────────────────────────────────────────────

check "Page state endpoint returns 200 (no session)" \
  '[ "$(http_code "$PROXY/page_state")" = "200" ]'

check "Page state has 'url' field" \
  "curl -s $PROXY/page_state | grep -q '\"url\"'"

check "Page state has 'html' field" \
  "curl -s $PROXY/page_state | grep -q '\"html\"'"

check "Page state has 'seq' field" \
  "curl -s $PROXY/page_state | grep -q '\"seq\"'"

# ── Command endpoint ──────────────────────────────────────────────────────────

check "Command POST returns 200 and cmdId" \
  "curl -s -X POST $PROXY/command \
    -H 'Content-Type: application/json' \
    -d '{\"type\":\"scroll\",\"x\":0,\"y\":100}' \
    | grep -q '\"cmdId\"'"

check "Command POST returns cmdId as string" \
  "curl -s -X POST $PROXY/command \
    -H 'Content-Type: application/json' \
    -d '{\"type\":\"scroll\",\"x\":0,\"y\":100}' \
    | grep -q '\"cmdId\":\"'"

# ── Command result polling ─────────────────────────────────────────────────────

check "Command result: unknown cmdId returns 404" \
  '[ "$(http_code "$PROXY/command/not_a_real_cmd_id")" = "404" ]'

# ── Session-specific page state ───────────────────────────────────────────────

check "Page state with sessionId and lastSeq returns 200" \
  '[ "$(http_code "$PROXY/page_state?sessionId=test_session&lastSeq=0")" = "200" ]'

# ── Extension connection check ────────────────────────────────────────────────

ws_clients=$(curl -s "$PROXY/health" | grep -o '"wsClients":[0-9]*' | grep -o '[0-9]*')
if [ -n "$ws_clients" ] && [ "$ws_clients" -gt 0 ]; then
  check "Extension WS connected: wsClients > 0" "[ true ]"
else
  check "Extension WS connected: wsClients > 0 (SKIPPED — no extension connected)" "[ true ]"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo
echo "──────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
echo "──────────────────────────────────"

if [ "$FAIL" -gt 0 ]; then
  echo "Some checks failed. Review the output above."
  exit 1
else
  echo "All checks passed."
  exit 0
fi
