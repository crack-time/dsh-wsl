#!/usr/bin/env bash
set -u
cd "$HOME/.dshwsl" || exit 1
pkill -f 'exec-server.js' 2>/dev/null || true
sleep 0.5
: > exec.log
setsid nohup "$HOME/.zcode/server/node" exec-server.js > exec.log 2>&1 < /dev/null &
disown || true
sleep 1.5
pgrep -f 'exec-server.js' | head -1 > daemon.pid
echo "pid=$(cat daemon.pid)"
echo "--- log ---"
cat exec.log