#!/bin/sh
set -e

# PaaS runtimes (Railway, Render, ...) bind-mount the persistent volume at
# /app/server/data with root ownership, while the image runs as USER node.
# Chown the data dir before starting so better-sqlite3 can create the DB
# there, then drop back to the unprivileged user.

ensure_owned() {
  dir="$1"
  [ -n "$dir" ] || return 0

  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "docker-entrypoint: could not create $dir; continuing" >&2
  fi
  [ -d "$dir" ] || return 0

  if [ "$(stat -c %u "$dir" 2>/dev/null)" = "$NODE_UID" ]; then
    return 0
  fi

  if ! chown -R "$NODE_UID:$NODE_GID" "$dir" 2>/dev/null; then
    echo "docker-entrypoint: could not chown $dir; continuing" >&2
  fi
}

if [ "$(id -u)" = "0" ]; then
  NODE_UID="$(id -u node)"
  NODE_GID="$(id -g node)"

  ensure_owned /app/server/data
  if [ -n "$FREEAPI_DB_PATH" ]; then
    ensure_owned "$(dirname "$FREEAPI_DB_PATH")"
  fi
  if [ -n "$FREEAPI_DB_BACKUP_PATH" ]; then
    ensure_owned "$(dirname "$FREEAPI_DB_BACKUP_PATH")"
  fi

  # Launch Neon PostgreSQL Persistence Daemon in background under node user
  if [ -n "$NEON_DATABASE_URL" ]; then
    echo "[NeonSync] Starting Neon PostgreSQL persistence daemon in background..."
    (setpriv --reuid=node --regid=node --init-groups -- node /app/neon-sync.cjs daemon) &
  fi

  # Exec server as PID 1 so signals reach the process cleanly
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

if [ -n "$NEON_DATABASE_URL" ]; then
  echo "[NeonSync] Starting Neon PostgreSQL persistence daemon in background..."
  node /app/neon-sync.cjs daemon &
fi

exec "$@"
