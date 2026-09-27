#!/bin/sh
# Pull the latest main and restart whatever changed. Runs on the server, by
# itself after every merge (autodeploy.sh) or by hand:
#
#   /opt/fitfilesize/deploy/deploy.sh
#
# A deploy restarts the API and workers; runs in progress are picked up by the
# page's automatic restart, and uploads survive on the data volume.
set -eu
cd "$(dirname "$0")/.."

# One deploy at a time: autodeploy.sh holds this lock while it calls us.
if [ -z "${FITFILESIZE_DEPLOY_LOCKED:-}" ]; then
  exec 9>/run/lock/fitfilesize-deploy.lock
  flock -n 9 || { echo "another deploy is running"; exit 1; }
fi

git pull --ff-only
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --remove-orphans
docker image prune -f >/dev/null

echo "waiting for the API..."
for _ in $(seq 1 30); do
  if docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T api \
      python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health', timeout=5).read().decode())" 2>/dev/null; then
    exit 0
  fi
  sleep 5
done
echo "API did not report healthy within 150 s; check: docker compose -f deploy/docker-compose.yml logs --tail 50"
exit 1
