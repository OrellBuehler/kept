#!/usr/bin/env bash
# Captures the App Store screenshots from a booted simulator that has the Debug app installed.
# The app is launched once per screen with the server, the user and the page as launch arguments
# (a Debug build signs in and opens the page by itself, see AppModel.screenshotLaunch), so
# nothing is tapped.
#
# Usage: ios.sh <simulator udid> <work dir of server.sh> <output dir>
set -euo pipefail

DEVICE_ID="$1"
WORK="$2"
OUT="$3"
BUNDLE_ID="ch.orellbuehler.kept"
SETTLE_SECONDS="${SETTLE_SECONDS:-8}"
# shellcheck source=/dev/null
. "$WORK/env"
SERVER="http://localhost:$KEPT_SHOTS_PORT"
mkdir -p "$OUT"

launch() {
  local path="$1"
  local args=(
    -screenshot_server "$SERVER"
    -screenshot_username "$KEPT_SHOTS_USERNAME"
    -screenshot_password "$KEPT_SHOTS_PASSWORD"
  )
  if [ -n "$path" ]; then
    args+=(-screenshot_path "$path")
  fi
  xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" 2>/dev/null </dev/null || true
  xcrun simctl launch "$DEVICE_ID" "$BUNDLE_ID" "${args[@]}" >/dev/null </dev/null
}

xcrun simctl status_bar "$DEVICE_ID" override \
  --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100

# The first launch after an install is slow, and it signs in: give it time and throw it away.
launch ""
sleep 25

while read -r name path appearance <&3; do
  xcrun simctl ui "$DEVICE_ID" appearance "$appearance" </dev/null
  launch "$path"
  sleep "$SETTLE_SECONDS"
  file="$OUT/$name.png"
  xcrun simctl io "$DEVICE_ID" screenshot "$file" </dev/null
  # A blank screen compresses to well under this; a real one never does.
  if [ "$(stat -f%z "$file")" -lt 150000 ]; then
    echo "$name looks blank, waiting and capturing again" >&2
    sleep "$SETTLE_SECONDS"
    xcrun simctl io "$DEVICE_ID" screenshot "$file" </dev/null
  fi
done 3<"$WORK/screens"

xcrun simctl ui "$DEVICE_ID" appearance light
xcrun simctl status_bar "$DEVICE_ID" clear
