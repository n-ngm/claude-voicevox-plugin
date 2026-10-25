#!/bin/sh
# Run a script with Node.js 18+ regardless of the node version resolved from
# the directory where Claude Code was launched (nvm / mise / volta etc.).
#
# Resolution order:
#   1. $VOICEVOX_NODE
#   2. node on PATH
#   3. Well-known install locations (newest version first)

MIN_MAJOR=18

is_usable() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null
}

candidates() {
  [ -n "$VOICEVOX_NODE" ] && echo "$VOICEVOX_NODE"
  command -v node 2>/dev/null
  ls -d \
    "$HOME"/.local/share/mise/installs/node/*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.asdf/installs/nodejs/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    2>/dev/null | { sort -r -V 2>/dev/null || cat; }
  echo "$HOME/.volta/bin/node"
  echo /opt/homebrew/bin/node
  echo /usr/local/bin/node
  echo "$HOME/.linuxbrew/bin/node"
  echo /home/linuxbrew/.linuxbrew/bin/node
  echo /usr/bin/node
}

NODE_BIN=$(candidates | while IFS= read -r c; do
  if is_usable "$c"; then echo "$c"; break; fi
done)

if [ -z "$NODE_BIN" ]; then
  echo "voicevox: Node.js ${MIN_MAJOR}+ not found. Set VOICEVOX_NODE to the path of a suitable node binary." >&2
  exit 1
fi

# --install-deps: run `npm install` first if dependencies are missing
# (each plugin update creates a new version directory without node_modules).
# npm output goes to stderr so it does not break the MCP stdio protocol.
if [ "$1" = "--install-deps" ]; then
  shift
  PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)
  if [ ! -d "$PLUGIN_ROOT/node_modules/@modelcontextprotocol/sdk" ]; then
    NPM_BIN="$(dirname "$NODE_BIN")/npm"
    [ -x "$NPM_BIN" ] || NPM_BIN=$(command -v npm)
    LOCK_DIR="$PLUGIN_ROOT/.npm-install.lock"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "voicevox: installing dependencies in $PLUGIN_ROOT" >&2
      PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --prefix "$PLUGIN_ROOT" --omit=dev --no-audit --no-fund >&2
      rmdir "$LOCK_DIR"
    else
      # Another process is installing; wait for it to finish (up to 120s)
      i=0
      while [ -d "$LOCK_DIR" ] && [ "$i" -lt 120 ]; do sleep 1; i=$((i + 1)); done
    fi
  fi
fi

exec "$NODE_BIN" "$@"
