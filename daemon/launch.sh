#!/usr/bin/env bash
# Launch (or revive) the resident WSL exec-server for @crack/dsh-wsl.
#
# Resolves a Node binary by preference: a real node on PATH / the linuxbrew
# install first, then the bundled ~/.zcode/server/node as a fallback (it is not
# an ideal long-term dependency, it is just known-good when nothing else is).
set -u

cd "$HOME/.dshwsl" || exit 1

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
  elif [ -x /home/linuxbrew/.linuxbrew/bin/node ]; then
    echo /home/linuxbrew/.linuxbrew/bin/node
  elif [ -x "$HOME/.zcode/server/node" ]; then
    echo "$HOME/.zcode/server/node"
  else
    echo "error: no node found in WSL" >&2
    exit 1
  fi
}
NODE="$(resolve_node)"

pkill -f 'exec-server.js' 2>/dev/null || true
sleep 0.5
: > exec.log
setsid nohup "$NODE" exec-server.js > exec.log 2>&1 < /dev/null &
disown || true
sleep 1.5
pgrep -f 'exec-server.js' | head -1 > daemon.pid
echo "pid=$(cat daemon.pid)"
echo "node=$NODE"
echo "--- log ---"
cat exec.log