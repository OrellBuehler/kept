#!/usr/bin/env bash
# Starts a throwaway Kept server for the store screenshots: a fresh SQLite database in the work
# directory, one user, and the made-up household of scripts/seed-demo. The server keeps running;
# its pid is in <work dir>/server.pid.
#
# Writes <work dir>/env (port, username, password of the throwaway user) and <work dir>/screens,
# one line per screenshot: name, web path, appearance (light or dark).
#
# Usage: server.sh <work dir>        KEPT_SHOTS_PORT picks the port (default 3210)
set -euo pipefail

WORK="$(mkdir -p "$1" && cd "$1" && pwd)"
PORT="${KEPT_SHOTS_PORT:-3210}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
URL="http://localhost:$PORT"
API="$URL/api/app/v1"
USERNAME="alex"
PASSWORD="$(openssl rand -hex 16)"

cd "$ROOT"
bun run build

env -u DATABASE_URL DATABASE_PATH="$WORK/kept.db" ORIGIN="$URL" PORT="$PORT" \
  KEPT_SECRET_KEY="$(openssl rand -base64 32)" \
  nohup bun build/index.js >"$WORK/server.log" 2>&1 &
echo $! >"$WORK/server.pid"
trap 'kill "$(cat "$WORK/server.pid")" 2>/dev/null || true' ERR

for _ in $(seq 1 60); do
  curl -sf "$API/server" >/dev/null && break
  kill -0 "$(cat "$WORK/server.pid")" 2>/dev/null || break
  sleep 1
done
if ! curl -sf "$API/server" >/dev/null; then
  echo "the server did not start:" >&2
  cat "$WORK/server.log" >&2
  exit 1
fi

status=$(curl -sS -o /dev/null -w '%{http_code}' -H "Origin: $URL" -H 'Accept: text/html' \
  --data-urlencode "username=$USERNAME" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "displayName=Alex Example" \
  "$URL/setup")
if [ "$status" != "303" ]; then
  echo "creating the user failed (HTTP $status)" >&2
  exit 1
fi

KEPT_SEED_USERNAME="$USERNAME" KEPT_SEED_PASSWORD="$PASSWORD" bun scripts/seed-demo/run.ts --url "$URL"

# The detail screens need the ids the server gave the seeded records.
token=$(jq -n --arg u "$USERNAME" --arg p "$PASSWORD" '{username: $u, password: $p}' |
  curl -sSf -H 'Content-Type: application/json' -d @- "$API/auth/login" | jq -r '.token')
page() {
  curl -sSf -H "Authorization: Bearer $token" "$API/pages/$1"
}
account=$(page accounts | jq -r '[.data.accounts[] | select(.type == "current")][0].id')
bill=$(page bills | jq -r '[.data.list.items[] | select(.status == "open")][0].id // .data.list.items[0].id')
curl -sSf -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $token" "$API/auth/logout" >/dev/null
if [ -z "$account" ] || [ "$account" = "null" ] || [ -z "$bill" ] || [ "$bill" = "null" ]; then
  echo "the seeded account or bill was not found" >&2
  exit 1
fi

(
  umask 077
  printf 'KEPT_SHOTS_PORT=%s\nKEPT_SHOTS_USERNAME=%s\nKEPT_SHOTS_PASSWORD=%s\n' "$PORT" "$USERNAME" "$PASSWORD" >"$WORK/env"
)

cat >"$WORK/screens" <<EOF
overview / light
overview-dark / dark
accounts /accounts light
account /accounts/$account light
bills /bills light
bill /bills/$bill light
budgets /budgets light
forecast /forecast light
investments /investments light
pillar-3a /pillar-3a light
taxes /taxes light
reports /reports light
recurring /recurring light
EOF

echo "server ready at $URL"
