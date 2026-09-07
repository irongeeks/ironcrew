#!/bin/bash
# Dedicated Apple Silicon VZ VM. Does not inspect or modify default Lima/Colima state.
set -euo pipefail
umask 077
command_name=${1:?create|prepare|start|start-control|stop|status}; state_dir=${2:?Absolute private state directory}; shift 2
[[ $state_dir == /* && ${#state_dir} -lt 72 && $state_dir != *[[:space:]]* ]] || { echo 'Use an absolute path without spaces shorter than 72 characters.' >&2; exit 2; }
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'This profile requires Apple Silicon and Lima VZ.' >&2; exit 2; }
command -v limactl >/dev/null || { echo 'Install Lima explicitly before using this launcher.' >&2; exit 2; }
mkdir -p "$state_dir"; chmod 700 "$state_dir"
export LIMA_HOME="$state_dir/lima"
vm_name=w
case "$command_name" in
create)
  [[ ! -e $LIMA_HOME/$vm_name ]] || { echo 'Own VM already exists; use status/start.' >&2; exit 2; }
  cat > "$state_dir/vm.yaml" <<'YAML'
vmType: vz
arch: aarch64
cpus: 2
memory: 4GiB
disk: 16GiB
images:
- location: https://cloud-images.ubuntu.com/releases/noble/release-20260518/ubuntu-24.04-server-cloudimg-arm64.img
  arch: aarch64
  digest: sha256:6a61b967ba4a27dd1966f835a67643073ed55c2860ce3dc1cb0517282e6b8bec
mounts: []
propagateProxyEnv: false
containerd:
  system: false
  user: false
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
  forwardX11: false
hostResolver:
  enabled: false
dns: [1.1.1.1]
portForwards:
- guestPortRange: [1, 65535]
  guestIP: 0.0.0.0
  guestIPMustBeZero: false
  proto: any
  ignore: true
YAML
  if [[ ${1:-worker} == control ]]; then
    # Explicit local GUI/preview forwards only, before the deny-all rule.
    sed -i '' '/^portForwards:$/a\
- guestPort: 8790\
  hostPort: 8790\
  hostIP: 127.0.0.1\
- guestPort: 8792\
  hostPort: 8792\
  hostIP: 127.0.0.1\
' "$state_dir/vm.yaml"
  elif [[ ${1:-worker} != worker ]]; then exit 2; fi
  limactl start --tty=false --name="$vm_name" "$state_dir/vm.yaml"
  ;;
prepare)
  source_archive=${1:?Trusted source archive rooted at next/ contents}
  [[ -f $source_archive ]] || exit 2
  limactl start --tty=false "$vm_name"
  limactl shell "$vm_name" bash -c 'mkdir -p /tmp/ironcrew-bootstrap && chmod 700 /tmp/ironcrew-bootstrap'
  limactl copy "$source_archive" "$vm_name:/tmp/ironcrew-bootstrap/source.tar"
  limactl shell --workdir=/tmp/ironcrew-bootstrap "$vm_name" bash -s <<'GUEST'
set -euo pipefail
umask 077
base="$HOME/ironcrew-worker"
mkdir -p "$base/next"
tar -xf source.tar -C "$base/next"
if [[ -f $base/next/apps/control/main.ts ]]; then code_root="$base/next"; code_ext=ts
elif [[ -f $base/next/dist/apps/control/main.js ]]; then code_root="$base/next/dist"; code_ext=js
else echo 'Source or compiled release layout missing.' >&2; exit 2; fi
sudo apt-get update -qq
sudo apt-get install -y build-essential meson ninja-build pkg-config libcap-dev curl xz-utils busybox-static php-cli
bash "$code_root/packages/tools/isolation/bootstrap-lab.sh" "$base"
printf 'profile ironcrew-worker-bwrap "%s/tooling/bwrap-build/bwrap" flags=(unconfined) {\n userns,\n}\n' "$base" > "$base/bwrap.apparmor"
sudo install -m 0644 "$base/bwrap.apparmor" /etc/apparmor.d/ironcrew-worker-bwrap
sudo apparmor_parser -r /etc/apparmor.d/ironcrew-worker-bwrap
cd "$base/next"
PATH="$base/tooling/node/bin:$PATH" npx --yes pnpm@10.30.1 install --frozen-lockfile
"$base/tooling/node/bin/node" "$code_root/packages/tools/isolation/cli.$code_ext" prepare "$base/profile" "$base/tooling/node" "$base/tooling/bwrap-build/bwrap" /sys/fs/cgroup/ironcrew-worker /usr/bin/php
sudo bash "$code_root/packages/tools/isolation/run-delegated.sh" "$(id -un)" /sys/fs/cgroup/ironcrew-worker "$base/tooling/node/bin/node" "$code_root/packages/tools/isolation/cli.$code_ext" attest "$base/profile/profile.json" "$base/provisioning-attestation.json"
rm -f /tmp/ironcrew-bootstrap/source.tar
GUEST
  ;;
start)
  worker_config=${1:?Worker enrollment JSON}; ca_file=${2:?Explicit WSS CA PEM}
  [[ -f $worker_config && -f $ca_file ]] || exit 2
  limactl start --tty=false "$vm_name"
  limactl shell "$vm_name" bash -c 'mkdir -p /tmp/ironcrew-bootstrap && chmod 700 /tmp/ironcrew-bootstrap'
  limactl copy "$worker_config" "$vm_name:/tmp/ironcrew-bootstrap/worker.json"
  limactl copy "$ca_file" "$vm_name:/tmp/ironcrew-bootstrap/ca.pem"
  limactl shell "$vm_name" bash -s <<'GUEST'
set -euo pipefail
umask 077
base="$HOME/ironcrew-worker"
if [[ -f $base/next/apps/control/main.ts ]]; then code_root="$base/next"; code_ext=ts; else code_root="$base/next/dist"; code_ext=js; fi
chmod 700 /tmp/ironcrew-bootstrap
chmod 600 /tmp/ironcrew-bootstrap/worker.json /tmp/ironcrew-bootstrap/ca.pem
mkdir -p "$base/config"
mv /tmp/ironcrew-bootstrap/ca.pem "$base/config/ca.pem"
"$base/tooling/node/bin/node" "$code_root/packages/tools/isolation/stage-worker.$code_ext" /tmp/ironcrew-bootstrap/worker.json "$base"
rm /tmp/ironcrew-bootstrap/worker.json
# Recreate cgroup delegation after every boot. Every startup reruns all probes.
exec sudo bash "$code_root/packages/tools/isolation/run-delegated.sh" "$(id -un)" /sys/fs/cgroup/ironcrew-worker "$base/tooling/node/bin/node" "$code_root/apps/worker/main.$code_ext" "$base/config/worker.json"
GUEST
  ;;
start-control)
  control_config=${1:?Control configuration JSON}; tls_cert=${2:?TLS certificate PEM}; tls_key=${3:?TLS private key PEM}
  [[ -f $control_config && -f $tls_cert && -f $tls_key ]] || exit 2
  limactl start --tty=false "$vm_name"
  limactl shell "$vm_name" bash -c 'mkdir -p /tmp/ironcrew-bootstrap && chmod 700 /tmp/ironcrew-bootstrap'
  limactl copy "$control_config" "$vm_name:/tmp/ironcrew-bootstrap/control.json"
  limactl copy "$tls_cert" "$vm_name:/tmp/ironcrew-bootstrap/tls-cert.pem"
  limactl copy "$tls_key" "$vm_name:/tmp/ironcrew-bootstrap/tls-key.pem"
  limactl shell "$vm_name" bash -s <<'GUEST'
set -euo pipefail
umask 077
base="$HOME/ironcrew-worker"
if [[ -f $base/next/apps/control/main.ts ]]; then code_root="$base/next"; code_ext=ts; else code_root="$base/next/dist"; code_ext=js; fi
mkdir -p "$base/control"
chmod 600 /tmp/ironcrew-bootstrap/control.json /tmp/ironcrew-bootstrap/tls-{cert,key}.pem
mv /tmp/ironcrew-bootstrap/tls-{cert,key}.pem "$base/control/"
"$base/tooling/node/bin/node" "$code_root/packages/tools/isolation/stage-control.$code_ext" /tmp/ironcrew-bootstrap/control.json "$base"
rm /tmp/ironcrew-bootstrap/control.json
cd "$base/next"
# Build the actual React interface and production files in the guest.
if [[ ! -f dist/web/index.html ]]; then PATH="$base/tooling/node/bin:$PATH" npx --yes pnpm@10.30.1 build; fi
exec sudo bash "$code_root/packages/tools/isolation/run-delegated.sh" "$(id -un)" /sys/fs/cgroup/ironcrew-worker /usr/bin/env IRONCREW_DATA_DIR="$base/control" IRONCREW_HOST=127.0.0.1 IRONCREW_PORT=8790 IRONCREW_PUBLIC_URL=https://localhost:8790 IRONCREW_TLS_CERT="$base/control/tls-cert.pem" IRONCREW_TLS_KEY="$base/control/tls-key.pem" "$base/tooling/node/bin/node" "$code_root/apps/control/main.$code_ext"
GUEST
  ;;
stop) limactl stop "$vm_name" ;;
status) limactl list --json ;;
*) exit 2 ;;
esac
