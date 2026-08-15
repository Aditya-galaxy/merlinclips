#!/usr/bin/env bash
#
# Run a settlement pass on a schedule, from a machine that can sign.
#
# Circle Agent Stack keeps its session in the OS keychain and authenticates
# with an emailed OTP, so it cannot run inside a container. Cloud Run does
# everything else — campaigns, verification, hourly view observation, the gate
# — and reaches the executor only to fail. This closes that last gap without
# moving custody to a product family this project deliberately left.
#
# What it does, in order: refresh a short-lived GCS token, check the Circle
# session is still valid, run the pass, and say plainly when the session is
# close to expiring. That last part matters more than it looks — the session
# lasts about twenty days, and the failure mode is silent: payouts simply stop
# settling while everything else keeps working.
#
# Install (macOS, runs hourly):
#   ./scripts/settle-scheduled.sh --install
#
# Remove:
#   launchctl unload ~/Library/LaunchAgents/com.merlinclips.settle.plist
#
# Dry run by default. Set BROADCAST=true in the plist to actually pay.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.merlinclips.settle"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/merlinclips"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$REPO/scripts/settle-scheduled.sh</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/settle.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/settle.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- Dry run until you change this. Broadcasting is a decision, not a
         default a scheduler inherits. -->
    <key>BROADCAST</key><string>false</string>
  </dict>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Installed. Runs hourly, dry run."
  echo "  logs:      $LOG_DIR/settle.log"
  echo "  to arm it: edit BROADCAST to true in $PLIST, then reload"
  exit 0
fi

cd "$REPO"
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# A token, not a key file. `gcloud auth print-access-token` mints roughly an
# hour, so nothing durable is written anywhere.
if ! GCS_ACCESS_TOKEN="$(gcloud auth print-access-token 2>/dev/null)"; then
  echo "no gcloud token — run: gcloud auth login"
  exit 1
fi
export GCS_ACCESS_TOKEN

# The session is the thing that quietly runs out. Checked before the pass so
# the log says why rather than showing a settlement that did not happen.
STATUS="$(circle wallet status --output json 2>/dev/null || echo '{}')"
if ! echo "$STATUS" | grep -q '"tokenStatus": *"VALID"'; then
  echo "Circle session is not valid — payouts cannot be signed."
  echo "Run: circle wallet login <email>"
  exit 1
fi

EXPIRES="$(echo "$STATUS" | sed -n 's/.*"expiresIn": *"\([^"]*\)".*/\1/p' | head -1)"
echo "circle session expires in ${EXPIRES:-unknown}"
case "${EXPIRES:-}" in
  *d*)
    DAYS="${EXPIRES%%d*}"
    if [ "${DAYS:-99}" -le 3 ] 2>/dev/null; then
      echo "WARNING: session expires in ${DAYS}d. Re-login before it lapses or"
      echo "         settlement stops silently while everything else keeps working."
    fi
    ;;
  *) echo "WARNING: session expiry not reported — re-login if payouts stop." ;;
esac

bun run settle
