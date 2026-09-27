#!/bin/sh
# Deploy whatever has been merged to main. Runs every two minutes from a
# systemd timer (installed by setup.sh); the repository is public, so fetching
# needs no key:
#
#   systemctl list-timers fitfilesize-autodeploy
#   journalctl -t fitfilesize-autodeploy
#
# A commit that fails to deploy is tried once, not every two minutes: the next
# attempt waits for a new commit (or for someone to run deploy.sh by hand).
set -u
cd "$(dirname "$0")/.."
TAG=fitfilesize-autodeploy
TRIED=${STATE_DIRECTORY:-/var/lib/fitfilesize}/autodeploy-tried

# One deploy at a time, whoever starts it.
exec 9>/run/lock/fitfilesize-deploy.lock
flock -n 9 || exit 0

git fetch -q origin main 2>/dev/null || { logger -t "$TAG" "fetch failed"; exit 0; }
head=$(git rev-parse HEAD)
want=$(git rev-parse origin/main)
[ "$head" = "$want" ] && exit 0
[ -f "$TRIED" ] && [ "$(cat "$TRIED")" = "$want" ] && exit 0

# Only move forward: a server checkout that has drifted is left for a person.
if ! git merge-base --is-ancestor "$head" "$want"; then
  logger -t "$TAG" "HEAD $head is not behind origin/main $want; not deploying"
  echo "$want" >"$TRIED"
  exit 0
fi

echo "$want" >"$TRIED"
logger -t "$TAG" "deploying $(git log -1 --format='%h %s' "$want")"
if out=$(FITFILESIZE_DEPLOY_LOCKED=1 deploy/deploy.sh 2>&1); then
  logger -t "$TAG" "deployed $(git rev-parse --short HEAD)"
else
  logger -t "$TAG" "deploy of $want failed: $(printf '%s' "$out" | tail -5)"
  exit 1
fi
