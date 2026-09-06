#!/usr/bin/env bash
# Sourced by setup.sh. Runtime tools live in a user-owned prefix; OS build
# packages use the host's package manager only when a required tool is missing.

bootstrap_error() { echo "[IronCrew] $*" >&2; return 1; }
bootstrap_info() { echo "[IronCrew] $*"; }
has_command() { command -v "$1" >/dev/null 2>&1; }
node_ready() {
  has_command node && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' >/dev/null 2>&1 && has_command npm
}
apple_tools_ready() { [[ "${BOOTSTRAP_OS:-}" != Darwin ]] || xcode-select -p >/dev/null 2>&1; }
git_ready() { apple_tools_ready && has_command git && git --version >/dev/null 2>&1; }
python_ready() { apple_tools_ready && has_command python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; }
compiler_ready() { apple_tools_ready && has_command c++ && c++ --version >/dev/null 2>&1; }
pnpm_ready() {
  has_command pnpm && [[ "$(cd /; COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_AUTO_PIN=0 COREPACK_ENABLE_PROJECT_SPEC=0 npm_config_manage_package_manager_versions=false pnpm_config_manage_package_manager_versions=false pnpm_config_pm_on_fail=ignore pnpm --version 2>/dev/null)" == "${PNPM_VERSION}" ]]
}

privileged() {
  if [[ "$(id -u)" == "0" ]]; then "$@";
  elif has_command sudo; then sudo "$@";
  else bootstrap_error "Missing system packages require root or sudo. Run the listed package-manager command as an administrator, then rerun setup."; return 1;
  fi
}

bootstrap_platform() {
  BOOTSTRAP_OS="$(uname -s)"
  case "${BOOTSTRAP_OS}" in Linux|Darwin) ;; *) bootstrap_error "Automatic setup supports Linux and macOS. On Windows use WSL2 with a Linux distribution."; return 1;; esac
  case "$(uname -m)" in x86_64|amd64) BOOTSTRAP_ARCH=x64;; arm64|aarch64) BOOTSTRAP_ARCH=arm64;; *) bootstrap_error "Unsupported architecture: $(uname -m). Use a supported x64 or arm64 host."; return 1;; esac
  BOOTSTRAP_PREFIX="${IRONCREW_TOOLCHAIN_DIR:-${HOME}/.local/share/ironcrew/toolchain}"
  [[ "${BOOTSTRAP_PREFIX}" == /* ]] || { bootstrap_error "IRONCREW_TOOLCHAIN_DIR must be an absolute path."; return 1; }
  # Keep working system tools first. Activate our previously installed runtime
  # only if the shell's Node is missing or too old.
  if ! node_ready && [[ -x "${BOOTSTRAP_PREFIX}/node/bin/node" ]]; then
    export PATH="${BOOTSTRAP_PREFIX}/node/bin:${PATH}"
  fi
  PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9][0-9.]*\).*/\1/p' "${ROOT_DIR}/package.json")"
  [[ "${PNPM_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { bootstrap_error "package.json must pin an exact pnpm version."; return 1; }
  if ! pnpm_ready && [[ -x "${BOOTSTRAP_PREFIX}/bin/pnpm" ]]; then
    export PATH="${BOOTSTRAP_PREFIX}/bin:${PATH}"
  fi
}

missing_requirements() {
  MISSING=()
  node_ready || MISSING+=("Node.js >=26 with npm")
  pnpm_ready || MISSING+=("pnpm ${PNPM_VERSION}")
  git_ready || MISSING+=("Git")
  has_command curl || MISSING+=("curl")
  has_command tar || MISSING+=("tar")
  has_command gzip || MISSING+=("gzip")
  has_command sha256sum || has_command shasum || MISSING+=("SHA-256 utility")
  python_ready || MISSING+=("Python >=3.8")
  apple_tools_ready && has_command make || MISSING+=("make")
  compiler_ready || MISSING+=("C++ compiler")
}

install_linux_packages() {
  local manager packages=() need_compiler=0
  has_command make && compiler_ready || need_compiler=1
  if has_command apt-get; then
    manager=apt
    git_ready || packages+=(git)
    has_command curl || packages+=(curl ca-certificates)
    has_command tar || packages+=(tar)
    has_command gzip || packages+=(gzip)
    has_command sha256sum || has_command shasum || packages+=(coreutils)
    python_ready || packages+=(python3)
    [[ "${need_compiler}" == 0 ]] || packages+=(build-essential)
  elif has_command dnf || has_command yum; then
    manager=dnf; has_command dnf || manager=yum
    git_ready || packages+=(git)
    has_command curl || packages+=(curl ca-certificates)
    has_command tar || packages+=(tar)
    has_command gzip || packages+=(gzip)
    has_command sha256sum || has_command shasum || packages+=(coreutils)
    python_ready || packages+=(python3)
    [[ "${need_compiler}" == 0 ]] || packages+=(make gcc-c++)
  elif has_command pacman; then
    manager=pacman
    git_ready || packages+=(git)
    has_command curl || packages+=(curl ca-certificates)
    has_command tar || packages+=(tar)
    has_command gzip || packages+=(gzip)
    has_command sha256sum || has_command shasum || packages+=(coreutils)
    python_ready || packages+=(python)
    [[ "${need_compiler}" == 0 ]] || packages+=(base-devel)
  elif has_command zypper; then
    manager=zypper
    git_ready || packages+=(git)
    has_command curl || packages+=(curl ca-certificates)
    has_command tar || packages+=(tar)
    has_command gzip || packages+=(gzip)
    has_command sha256sum || has_command shasum || packages+=(coreutils)
    python_ready || packages+=(python3)
    [[ "${need_compiler}" == 0 ]] || packages+=(make gcc-c++)
  else
    # A supported package manager is unnecessary on an already provisioned host.
    if has_command git && has_command curl && has_command tar && has_command gzip && (has_command sha256sum || has_command shasum) && python_ready && has_command make && compiler_ready; then return 0; fi
    bootstrap_error "Missing system tools; supported Linux package managers: apt-get, dnf, yum, pacman, zypper. Install Git, curl, tar/gzip, a SHA-256 utility, Python >=3.8, make and a C++ compiler, then rerun setup."
    return 1
  fi
  [[ ${#packages[@]} -gt 0 ]] || return 0
  bootstrap_info "Installing missing system packages (${manager}): ${packages[*]}"
  case "${manager}" in
    apt) privileged apt-get update; privileged apt-get install -y "${packages[@]}";;
    dnf|yum) privileged "${manager}" install -y "${packages[@]}";;
    pacman) privileged pacman -S --needed --noconfirm "${packages[@]}";;
    zypper) privileged zypper --non-interactive install "${packages[@]}";;
  esac
}

install_macos_packages() {
  if ! xcode-select -p >/dev/null 2>&1 || ! compiler_ready || ! has_command make || ! git --version >/dev/null 2>&1; then
    bootstrap_info "Installing Apple's Command Line Tools. Confirm the macOS installer dialog; setup will continue after installation."
    xcode-select --install || { bootstrap_error "Could not start Command Line Tools installation. Complete it in macOS Software Update and rerun setup."; return 1; }
    # Apple's installer is asynchronous. A bounded wait allows the same setup
    # invocation to continue while still giving unattended failures an exit.
    local attempt=0
    until xcode-select -p >/dev/null 2>&1 && compiler_ready && git --version >/dev/null 2>&1; do
      [[ "${attempt}" -lt 180 ]] || { bootstrap_error "Command Line Tools installation is not finished. Rerun setup once it completes."; return 1; }
      sleep 10; attempt=$((attempt + 1))
    done
  fi
  if ! python_ready; then
    if has_command brew; then brew install python;
    else
      bootstrap_info "Python is missing. Installing Homebrew from its official installer, then Python."
      install_homebrew
      brew install python
    fi
  fi
}


install_homebrew() {
  local brew_script brew_bin
  [[ "$(id -u)" != 0 ]] || { bootstrap_error "Homebrew must run as a regular user. Rerun setup without sudo."; return 1; }
  brew_script="$(mktemp)"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 \
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "${brew_script}" || { rm -f "${brew_script}"; return 1; }
  /bin/bash "${brew_script}" || { rm -f "${brew_script}"; return 1; }
  rm -f "${brew_script}"
  case "${BOOTSTRAP_ARCH}" in arm64) brew_bin=/opt/homebrew/bin;; x64) brew_bin=/usr/local/bin;; esac
  export PATH="${brew_bin}:${PATH}"
  has_command brew || { bootstrap_error "Homebrew installation failed."; return 1; }
}

install_node() (
  # Run in a subshell so trap cleanup cannot affect the caller's traps.
  local tmp archive checksum actual platform version
  tmp="$(mktemp -d)"
  trap 'rm -rf -- "${tmp}"' EXIT
  case "${BOOTSTRAP_OS}" in Darwin) platform=darwin;; Linux) platform=linux;; esac
  bootstrap_info "Downloading the latest Node.js 26 release from nodejs.org."
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 \
    https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt -o "${tmp}/SHASUMS256.txt"
  archive="$(awk -v suffix="-${platform}-${BOOTSTRAP_ARCH}.tar.gz" '$2 ~ /^node-v26\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "${tmp}/SHASUMS256.txt")"
  [[ "${archive}" =~ ^node-v26\.[0-9]+\.[0-9]+-(linux|darwin)-(x64|arm64)\.tar\.gz$ ]] || { bootstrap_error "No supported Node 26 download found for this platform."; return 1; }
  version="${archive#node-}"; version="${version%%-*}"
  # Resolve the immutable version URL from the checksum list to avoid a latest
  # alias changing between checksum and archive downloads.
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 \
    "https://nodejs.org/dist/${version}/${archive}" -o "${tmp}/${archive}"
  checksum="$(awk -v file="${archive}" '$2==file {print $1; exit}' "${tmp}/SHASUMS256.txt")"
  if has_command sha256sum; then actual="$(sha256sum "${tmp}/${archive}")"; else actual="$(shasum -a 256 "${tmp}/${archive}")"; fi
  actual="${actual%% *}"
  [[ "${checksum}" =~ ^[a-f0-9]{64}$ && "${actual}" == "${checksum}" ]] || { bootstrap_error "Node download checksum mismatch; nothing was installed."; return 1; }
  mkdir -p "${tmp}/unpacked"
  tar -xzf "${tmp}/${archive}" -C "${tmp}/unpacked" --strip-components=1 --no-same-owner
  "${tmp}/unpacked/bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 26 ? 0 : 1)' || { bootstrap_error "Node 26 cannot run on this OS. Check the supported OS/glibc version."; return 1; }
  mkdir -p "${BOOTSTRAP_PREFIX}/runtimes"
  local destination="${BOOTSTRAP_PREFIX}/runtimes/${version}-${platform}-${BOOTSTRAP_ARCH}"
  [[ ! -e "${destination}" ]] || { bootstrap_error "An incomplete runtime already exists at ${destination}; inspect it before retrying."; return 1; }
  mv "${tmp}/unpacked" "${destination}"
  # The active path is our own link, never a system Node installation.
  [[ ! -e "${BOOTSTRAP_PREFIX}/node" || -L "${BOOTSTRAP_PREFIX}/node" ]] || { bootstrap_error "Refusing to replace a non-symlink ${BOOTSTRAP_PREFIX}/node."; return 1; }
  ln -sfn "${destination}" "${BOOTSTRAP_PREFIX}/node"
)

write_toolchain_environment() {
  mkdir -p "${BOOTSTRAP_PREFIX}"
  local environment="${BOOTSTRAP_PREFIX}/env.sh" line profile
  printf 'export PATH=%q:"$PATH"\n' "${BOOTSTRAP_PREFIX}/node/bin:${BOOTSTRAP_PREFIX}/bin" > "${environment}"
  # An explicit env file also works for non-login shells and service installation.
  printf -v line 'source %q' "${environment}"
  if [[ "${WRITE_PROFILE}" == 0 ]]; then bootstrap_info "Activate tools with: ${line}"; return 0; fi
  case "${SHELL:-/bin/bash}" in */zsh) profile="${HOME}/.zshrc";; */bash) profile="${HOME}/.bashrc";; *) bootstrap_info "Activate tools in new shells with: ${line}"; return 0;; esac
  if ! grep -Fqx "${line}" "${profile}" 2>/dev/null; then
    printf '\n# IronCrew toolchain\n%s\n' "${line}" >> "${profile}"
  fi
  bootstrap_info "Toolchain environment: ${environment}"
}

ensure_requirements() {
  bootstrap_platform
  missing_requirements
  if [[ ${#MISSING[@]} == 0 ]]; then bootstrap_info "All requirements already installed (Node $(node --version), pnpm ${PNPM_VERSION})."; return 0; fi
  bootstrap_info "Missing or incompatible: ${MISSING[*]}"
  if [[ "${CHECK_ONLY}" == 1 ]]; then return 1; fi
  case "${BOOTSTRAP_OS}" in Linux) install_linux_packages;; Darwin) install_macos_packages;; esac
  local user_tools=0
  if ! node_ready; then
    install_node
    export PATH="${BOOTSTRAP_PREFIX}/node/bin:${PATH}"
    hash -r
    node_ready || { bootstrap_error "Node.js/npm verification failed after installation."; return 1; }
    user_tools=1
  fi
  if ! pnpm_ready; then
    bootstrap_info "Installing pnpm ${PNPM_VERSION} in ${BOOTSTRAP_PREFIX}."
    npm install --global --prefix "${BOOTSTRAP_PREFIX}" "pnpm@${PNPM_VERSION}"
    export PATH="${BOOTSTRAP_PREFIX}/bin:${PATH}"
    hash -r
    user_tools=1
  fi
  missing_requirements
  [[ ${#MISSING[@]} == 0 ]] || { bootstrap_error "Requirements still missing after installation: ${MISSING[*]}"; return 1; }
  [[ "${user_tools}" == 0 ]] || write_toolchain_environment
  bootstrap_info "All requirements verified."
}
