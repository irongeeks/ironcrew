#!/bin/sh
# Production entrypoint: make bind-mounted /workspaces and /data writable by
# the node user when host UID does not match container UID 1000, then drop
# to node via gosu.
#
# We only chown when the top-level directory's owner differs from node's UID.
# The previous version ran `chown -R` on every boot, which mutated host
# ownership on Linux bind mounts and could be very slow on large volumes.
#
# Opt-out: set SKIP_OWNERSHIP_FIX=1 to skip entirely (e.g. when the host
# user already runs as UID 1000 and you don't want the container touching
# ownership at all).

set -eu

NODE_UID=$(id -u node)

fix_owner() {
  dir="$1"
  [ -d "$dir" ] || return 0
  # Compare top-level dir owner to the node user. If already correct, skip.
  current_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
  if [ "$current_uid" = "$NODE_UID" ]; then
    return 0
  fi
  # Ownership mismatch: recursively align so the node user can write.
  # Best-effort: ignore errors on read-only entries.
  chown -R node:node "$dir" 2>/dev/null || true
}

if [ "${SKIP_OWNERSHIP_FIX:-0}" != "1" ]; then
  fix_owner /workspaces
  fix_owner /data
fi

exec gosu node "$@"
