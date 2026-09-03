#!/bin/sh
# Dev entrypoint: make bind-mounted /workspaces writable by the node user
# when host UID does not match container UID 1000, then drop to node.
#
# Only chowns when the top-level owner differs from node, to avoid mutating
# host ownership or performing a recursive scan on every boot.
#
# Opt-out: set SKIP_OWNERSHIP_FIX=1 to skip entirely.

set -eu

NODE_UID=$(id -u node)

fix_owner() {
  dir="$1"
  [ -d "$dir" ] || return 0
  current_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
  if [ "$current_uid" = "$NODE_UID" ]; then
    return 0
  fi
  chown -R node:node "$dir" 2>/dev/null || true
}

if [ "${SKIP_OWNERSHIP_FIX:-0}" != "1" ]; then
  fix_owner /workspaces
fi

exec gosu node "$@"
