#!/bin/sh
# Explicit provisioning for an expendable Linux test VM/CI runner; never run on production hosts.
set -eu
lab_dir=${1:?Pass an absolute private lab directory}
case "$lab_dir" in /*) ;; *) exit 2;; esac
mkdir -p "$lab_dir/downloads" "$lab_dir/tooling"
case "$(uname -m)" in
 aarch64) node_arch=arm64; node_sha=f6d8eedc52170667d45730ac2f413c4aa1e7cd2165c9cac5746ef3cb0f4ec45a ;;
 x86_64) node_arch=x64; node_sha=5c4286dcd5bbd5acb1ccc7eb0e088bd5eb1e3affad671ee9364004f8f6a4a431 ;;
 *) exit 3;;
esac
node_archive="$lab_dir/downloads/node.tar.xz"
curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/dist/v26.4.0/node-v26.4.0-linux-$node_arch.tar.xz" -o "$node_archive"
printf '%s  %s\n' "$node_sha" "$node_archive" | sha256sum -c -
tar -xJf "$node_archive" -C "$lab_dir/tooling"
ln -sfn "node-v26.4.0-linux-$node_arch" "$lab_dir/tooling/node"
bwrap_archive="$lab_dir/downloads/bubblewrap.tar.xz"
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/containers/bubblewrap/releases/download/v0.12.0/bubblewrap-0.12.0.tar.xz -o "$bwrap_archive"
printf '%s  %s\n' 9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314 "$bwrap_archive" | sha256sum -c -
tar -xJf "$bwrap_archive" -C "$lab_dir/tooling"
meson setup "$lab_dir/tooling/bwrap-build" "$lab_dir/tooling/bubblewrap-0.12.0" -Dtests=false -Dman=disabled -Dassume_kernel=5.6.0 >"$lab_dir/meson.log"
ninja -C "$lab_dir/tooling/bwrap-build" >"$lab_dir/ninja.log"
printf 'Node and bubblewrap sources verified and built inside the dedicated lab.\n'

chmod 0755 "$lab_dir/tooling/bwrap-build/bwrap"
