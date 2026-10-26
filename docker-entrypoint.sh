#!/bin/sh
# Prepares the data folder, then runs the app as the unprivileged "node" user.
# Hosted volumes (Railway, Fly, ...) are usually mounted owned by root, which the "node" user could not write to.
set -e

DATA_DIR="$(dirname "${DB_FILE:-/data/tasks.db}")"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
