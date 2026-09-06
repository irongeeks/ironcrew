#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

CHECK_ONLY=0
WRITE_PROFILE=1
REQUIREMENTS_ONLY=0
START_AFTER_SETUP=0
WIZARD_ARGS=()
# Parse before installing anything: --help and invalid arguments are read-only.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift;;
    --no-profile) WRITE_PROFILE=0; shift;;
    --requirements-only) REQUIREMENTS_ONLY=1; shift;;
    --port)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ && ${#2} -le 5 ]] || { echo "--port requires a number from 1 to 65535" >&2; exit 1; }
      [[ $((10#$2)) -ge 1 && $((10#$2)) -le 65535 ]] || { echo "--port requires a number from 1 to 65535" >&2; exit 1; }
      WIZARD_ARGS+=(--port "$2"); shift 2;;
    --yes|-y) WIZARD_ARGS+=(--yes); shift;;
    --start) START_AFTER_SETUP=1; shift;;
    -h|--help)
      echo "Usage: bash scripts/setup.sh [--check | --requirements-only] [--port PORT] [--yes] [--start] [--no-profile]"
      echo "Installs missing Node.js 26, pinned pnpm, Git, Python and native build tools."
      echo "--check: inspect requirements without installing or changing files."
      echo "--no-profile: do not add the toolchain to your shell profile."
      echo "--requirements-only: install prerequisites without dependencies or configuration."
      exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

[[ -f package.json && -f scripts/setup-wizard.mjs ]] || { echo "Run this script from the IronCrew repository." >&2; exit 1; }
source "${SCRIPT_DIR}/lib/bootstrap-requirements.sh"
ensure_requirements
[[ "${CHECK_ONLY}" == 0 && "${REQUIREMENTS_ONLY}" == 0 ]] || exit 0

echo "[IronCrew] Installing project dependencies..."
pnpm install --frozen-lockfile
node scripts/setup-wizard.mjs "${WIZARD_ARGS[@]+"${WIZARD_ARGS[@]}"}"
if [[ "${START_AFTER_SETUP}" == 1 ]]; then
  echo "[IronCrew] Starting development server..."
  exec pnpm dev:local
fi
