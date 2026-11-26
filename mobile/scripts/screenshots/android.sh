#!/usr/bin/env bash
# Captures the Play Store screenshots from a running emulator that has the debug app installed.
# The app is started once per screen with the server, the user and the page as intent extras (a
# debug build signs in and opens the page by itself, see MainActivity), so nothing is tapped.
#
# Usage: android.sh <work dir of server.sh> <output dir>
set -euo pipefail

WORK="$1"
OUT="$2"
PACKAGE="ch.orellbuehler.kept"
SETTLE_SECONDS="${SETTLE_SECONDS:-6}"
# shellcheck source=/dev/null
. "$WORK/env"
# The emulator reaches the machine it runs on at 10.0.2.2.
SERVER="http://10.0.2.2:$KEPT_SHOTS_PORT"
mkdir -p "$OUT"

launch() {
  local path="$1"
  local args=(
    --es screenshot_server "$SERVER"
    --es screenshot_username "$KEPT_SHOTS_USERNAME"
    --es screenshot_password "$KEPT_SHOTS_PASSWORD"
  )
  if [ -n "$path" ]; then
    args+=(--es screenshot_path "$path")
  fi
  adb shell am force-stop "$PACKAGE" </dev/null
  adb shell am start -W -n "$PACKAGE/.MainActivity" "${args[@]}" >/dev/null </dev/null
}

signed_in() {
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 </dev/null || return 1
  adb exec-out cat /sdcard/window.xml </dev/null | grep -q 'text="Overview"'
}

# The first launch signs in; without it every picture would show the sign-in screen. Right after
# boot the emulator may not reach the server yet, so the launch is repeated until the overview is up.
for _ in 1 2 3 4 5; do
  launch ""
  for _ in 1 2 3 4 5 6; do
    sleep 4
    if signed_in; then
      break 2
    fi
  done
done
if ! signed_in; then
  echo "the app did not sign in" >&2
  adb exec-out screencap -p >"$OUT/failed.png" </dev/null
  exit 1
fi

while read -r name path appearance <&3; do
  if [ "$appearance" = "dark" ]; then
    adb shell cmd uimode night yes </dev/null
  else
    adb shell cmd uimode night no </dev/null
  fi
  launch "$path"
  sleep "$SETTLE_SECONDS"
  adb exec-out screencap -p >"$OUT/$name.png" </dev/null
done 3<"$WORK/screens"

adb shell cmd uimode night no </dev/null
