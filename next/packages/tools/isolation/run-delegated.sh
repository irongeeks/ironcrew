#!/bin/bash
# Administrator launcher for a dedicated Linux VM/CI worker. Production systemd
# services should use Delegate=cpu memory pids and an equivalent supervisor subgroup.
set -euo pipefail
worker_user=${1:?USER}; cgroup_root=${2:?CGROUP_ROOT}; shift 2
[[ $(id -u) == 0 && $# -gt 0 ]] || { echo 'Run this explicit VM provisioning launcher as root.' >&2; exit 2; }
[[ $cgroup_root =~ ^/sys/fs/cgroup/ironcrew-[a-zA-Z0-9_-]+$ ]] || exit 2
worker_uid=$(id -u "$worker_user"); worker_gid=$(id -g "$worker_user")
[[ $worker_uid != 0 ]] || exit 2
printf '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control
mkdir -p "$cgroup_root/supervisor"
chown "$worker_uid:$worker_gid" "$cgroup_root" "$cgroup_root/cgroup.procs" "$cgroup_root/cgroup.threads" "$cgroup_root/cgroup.subtree_control"
printf '+cpu +memory +pids' > "$cgroup_root/cgroup.subtree_control"
printf '%s' "$$" > "$cgroup_root/supervisor/cgroup.procs"
exec runuser -u "$worker_user" -- env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TZ=UTC "$@"
