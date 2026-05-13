#!/bin/sh
set -e

# start redis in background, ephemeral (no persistence)
redis-server --daemonize yes --save "" --appendonly no --bind 127.0.0.1 --port 6379

# wait until it answers PING
for i in $(seq 1 20); do
  if redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 0.1
done

exec node server.js
