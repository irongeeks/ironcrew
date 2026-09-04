#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# ---------- Validate environment ----------

if [[ ! -f package.json || ! -f scripts/setup-wizard.mjs ]]; then
  echo "Run this script from the IronCrew repository." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install from https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  echo "Node.js 22+ is required. Current: $(node -v)" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "pnpm is required. Install via: npm install -g pnpm" >&2
    exit 1
  fi
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1
fi

# ---------- Install dependencies ----------

echo "[IronCrew] Installing dependencies..."
pnpm install

# ---------- Run interactive wizard ----------

START_AFTER_SETUP="0"
WIZARD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { echo "Missing value for --port" >&2; exit 1; }
      WIZARD_ARGS+=(--port "$2")
      shift 2
      ;;
    --yes|-y)
      WIZARD_ARGS+=(--yes)
      shift
      ;;
    --start)
      START_AFTER_SETUP="1"
      shift
      ;;
    -h|--help)
      echo "Usage: bash scripts/setup.sh [--port PORT] [--yes] [--start]"
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

node scripts/setup-wizard.mjs "${WIZARD_ARGS[@]+"${WIZARD_ARGS[@]}"}"

# ---------- Optionally start ----------

if [[ "${START_AFTER_SETUP}" == "1" ]]; then
  echo "[IronCrew] Starting development server..."
  exec pnpm dev:local
fi
