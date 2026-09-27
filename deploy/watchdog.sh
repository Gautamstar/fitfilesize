#!/bin/sh
# Restart whatever /health says is stuck. Docker restarts a container whose
# process exits, but not one that hangs; this covers the hang. Runs every
# minute from a systemd timer (installed by setup.sh):
#
#   systemctl list-timers fitfilesize-watchdog
#   journalctl -t fitfilesize-watchdog
set -u
cd "$(dirname "$0")/.."
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
STAMP=/run/fitfilesize-watchdog

# The API's container healthcheck polls /health; "unhealthy" means three
# failures in a row, about 90 s. "starting" (a deploy) is left alone.
[ "$($C ps --format '{{.Health}}' api 2>/dev/null)" = unhealthy ] || exit 0

# One restart, then give the healthcheck time to see the result.
if [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -lt 300 ]; then
  exit 0
fi
touch "$STAMP"

body=$($C exec -T api python -c "
import urllib.request, urllib.error
try:
    print(urllib.request.urlopen('http://localhost:8000/health', timeout=10).read().decode())
except urllib.error.HTTPError as e:
    print(e.read().decode())
except Exception as e:
    print('no answer:', e)
" 2>&1)
case "$body" in
  *'"redis":false'*) target=redis ;;
  *'"worker":false'*) target=worker ;;
  *) target=api ;;
esac
logger -t fitfilesize-watchdog "health: $body; restarting $target"
# A stuck process ignores the polite stop, so skip the deploy grace period.
$C restart -t 10 "$target"
