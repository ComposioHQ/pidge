#!/usr/bin/env bash
# Explicit opt-in deployment: sync tracked source, migrate, build, and restart one service.
set -euo pipefail
: "${PIDGE_HOST:?Set the SSH destination for your own deployment}"
: "${PIDGE_REMOTE_DIR:?Set the absolute application directory on that host}"
: "${PIDGE_RUNTIME_USER:?Set the Linux user that runs the application}"
service="${PIDGE_SERVICE:-pidge}"
[[ "$PIDGE_HOST" != -* && "$PIDGE_HOST" != *[[:space:]]* ]] || { echo 'Invalid SSH destination' >&2; exit 2; }
[[ "$PIDGE_REMOTE_DIR" =~ ^/[a-zA-Z0-9_./-]+$ && "$PIDGE_REMOTE_DIR" != / && ! "$PIDGE_REMOTE_DIR" =~ (^|/)\.\.(/|$) ]] || { echo 'Use an absolute application directory without spaces or ..' >&2; exit 2; }
[[ "$PIDGE_RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$service" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid runtime user or service name' >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
# Archive honours export-ignore and never uploads ignored secrets, caches, or Git history.
git -C "$root" archive HEAD | tar -x -C "$source_dir"
ssh "$PIDGE_HOST" "test -f '$PIDGE_REMOTE_DIR/.env.local'"
# A listed HEIC format is insufficient without the HEVC decoder. Check before replacing the running app.
if ! ssh "$PIDGE_HOST" 'convert "heic:-[0]" -auto-orient -strip jpeg:- >/dev/null' < "$root/test/fixtures/photos/example.heic"; then
  echo 'HEIC conversion failed. On Ubuntu install imagemagick and libheif-plugin-libde265 before deploying.' >&2
  exit 1
fi
rsync -az --delete \
  --filter='+ .env.example' --exclude='.env*' \
  --exclude=node_modules --exclude=.next --exclude=.eve --exclude=.output \
  --exclude=.workflow-data --exclude=.data --exclude=.git \
  "$source_dir/" "$PIDGE_HOST:$PIDGE_REMOTE_DIR/"
ssh "$PIDGE_HOST" bash -s -- "$PIDGE_REMOTE_DIR" "$PIDGE_RUNTIME_USER" "$service" <<'REMOTE'
set -euo pipefail
app_dir=$1
runtime_user=$2
service=$3
cd "$app_dir"
docker compose up -d --wait postgres
CI=true pnpm install --frozen-lockfile --reporter=silent
set -a; . ./.env.local; set +a
pnpm db:migrate
pnpm build
unit=$(mktemp)
trap 'rm -f "$unit"' EXIT
sed -e "s|@PIDGE_REMOTE_DIR@|$app_dir|g" -e "s|@PIDGE_RUNTIME_USER@|$runtime_user|g" deploy/pidge.service.in > "$unit"
sudo install -m 644 "$unit" "/etc/systemd/system/$service.service"
sudo systemctl daemon-reload
sudo systemctl enable "$service.service"
sudo systemctl restart "$service.service"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/eve/v1/health"; then exit 0; fi
  sleep 1
done
echo 'Agent health check failed' >&2
exit 1
REMOTE
