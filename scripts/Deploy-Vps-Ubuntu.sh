#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ws-app-interna}"

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/backups"
chown -R 1000:1000 "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/backups"
cd "$APP_DIR"

docker compose pull --ignore-pull-failures
docker compose up -d --build app

echo "App levantada. Verifica:"
echo "  docker compose ps"
echo "  curl http://127.0.0.1:3000/api/health"
