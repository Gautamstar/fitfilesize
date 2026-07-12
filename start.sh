#!/bin/sh
# Run the queue worker and the API in one container. Render's free tier only
# covers web services, so the worker rides along instead of being its own
# service. The loop restarts it if it ever dies.
(
  while true; do
    python -m fitpdf.web.worker
    echo "worker exited, restarting in 2s"
    sleep 2
  done
) &

exec uvicorn fitpdf.web.app:create_app --factory --host 0.0.0.0 --port "${PORT:-8000}"
