#!/usr/bin/env bash
#
# Install IronCrew as a systemd service.
#
# Idempotent: safe to re-run after a `git pull` to refresh the unit file. It
# never overwrites an existing environment file and never touches the data
# directory.
#
#   sudo scripts/install-service.sh
#   sudo scripts/install-service.sh --prefix /srv/ironcrew --user crew
#   sudo scripts/install-service.sh --uninstall
#
# See deploy/README.md.

set -euo pipefail

SERVICE_NAME="ironcrew"
DEFAULT_PREFIX="/opt/ironcrew"
DEFAULT_USER="ironcrew"
DEFAULT_ENV_FILE="/etc/ironcrew/ironcrew.env"
UNIT_DIR="/etc/systemd/system"

# Repository root, derived from this script's location, so the installer works
# from any working directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
UNIT_TEMPLATE="${REPO_ROOT}/deploy/${SERVICE_NAME}.service"
ENV_TEMPLATE="${REPO_ROOT}/deploy/${SERVICE_NAME}.env.example"

PREFIX="${IRONCREW_PREFIX:-$DEFAULT_PREFIX}"
SERVICE_USER="${IRONCREW_USER:-$DEFAULT_USER}"
ENV_FILE="${IRONCREW_ENV_FILE:-$DEFAULT_ENV_FILE}"
NODE_BIN="${IRONCREW_NODE:-}"
MODE="install"

die() {
  echo "error: $*" >&2
  exit 1
}

info() { echo "  $*"; }

usage() {
  cat <<USAGE
Usage: sudo scripts/install-service.sh [options]

Options:
  --prefix PATH     Install location of the IronCrew checkout
                    (default: ${DEFAULT_PREFIX}, env: IRONCREW_PREFIX)
  --user NAME       System user the service runs as
                    (default: ${DEFAULT_USER}, env: IRONCREW_USER)
  --env-file PATH   Environment file the unit reads
                    (default: ${DEFAULT_ENV_FILE}, env: IRONCREW_ENV_FILE)
  --node PATH       node binary to run (default: autodetected, env: IRONCREW_NODE)
  --uninstall       Stop, disable and remove the service unit.
                    Data directory, environment file and service user are kept.
  -h, --help        This text.

The service is never started automatically; the exact commands to enable and
follow it are printed at the end.
USAGE
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    local suffix="${1:-}"
    die "must run as root. Try: sudo ${BASH_SOURCE[0]}${suffix:+ ${suffix}}"
  fi
}

# --- argument parsing -------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix needs a value"
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift
      ;;
    --user)
      [[ $# -ge 2 ]] || die "--user needs a value"
      SERVICE_USER="$2"
      shift 2
      ;;
    --user=*)
      SERVICE_USER="${1#*=}"
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file needs a value"
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
      ;;
    --node)
      [[ $# -ge 2 ]] || die "--node needs a value"
      NODE_BIN="$2"
      shift 2
      ;;
    --node=*)
      NODE_BIN="${1#*=}"
      shift
      ;;
    --uninstall)
      MODE="uninstall"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

# --- validation -------------------------------------------------------------

[[ "${PREFIX}" == /* ]] || die "--prefix must be an absolute path (got: ${PREFIX})"
[[ "${ENV_FILE}" == /* ]] || die "--env-file must be an absolute path (got: ${ENV_FILE})"
# Legacy sed renderer accepts only simple absolute paths. The modern installer
# scripts/deploy-service.mjs supports escaped spaces and special characters.
for service_path in "${PREFIX}" "${ENV_FILE}"; do
  [[ "${service_path}" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "legacy installer requires simple absolute paths; use scripts/deploy-service.mjs for other paths"
done
[[ "${SERVICE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid user name: ${SERVICE_USER}"

command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this machine does not use systemd"

UNIT_PATH="${UNIT_DIR}/${SERVICE_NAME}.service"
SERVICE_HOME="/var/lib/${SERVICE_USER}"
DATA_DIR="${PREFIX}/data"
LOGS_DIR="${DATA_DIR}/logs"

# --- uninstall --------------------------------------------------------------

if [[ "${MODE}" == "uninstall" ]]; then
  require_root --uninstall
  echo "Removing the ${SERVICE_NAME} service."

  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    info "stopping ${SERVICE_NAME}.service"
    systemctl stop "${SERVICE_NAME}.service"
  else
    info "${SERVICE_NAME}.service is not running"
  fi

  if systemctl is-enabled --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    info "disabling ${SERVICE_NAME}.service"
    systemctl disable "${SERVICE_NAME}.service" >/dev/null
  else
    info "${SERVICE_NAME}.service is not enabled"
  fi

  if [[ -f "${UNIT_PATH}" ]]; then
    rm -f "${UNIT_PATH}"
    info "removed ${UNIT_PATH}"
  else
    info "no unit file at ${UNIT_PATH}"
  fi

  systemctl daemon-reload
  systemctl reset-failed "${SERVICE_NAME}.service" >/dev/null 2>&1 || true

  cat <<SUMMARY

Done. Deliberately NOT removed:
  - the data directory ${DATA_DIR} (database and logs)
  - the environment file ${ENV_FILE} (your configuration and tokens)
  - the system user ${SERVICE_USER}
  - the application in ${PREFIX}
Delete those by hand if you really mean to. Back up ${DATA_DIR} first.
SUMMARY
  exit 0
fi

# --- install ----------------------------------------------------------------

require_root

[[ -f "${UNIT_TEMPLATE}" ]] || die "unit template not found: ${UNIT_TEMPLATE}"
[[ -f "${ENV_TEMPLATE}" ]] || die "env template not found: ${ENV_TEMPLATE}"

# node: explicit flag, then PATH, then the usual locations.
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "${NODE_BIN}" ]]; then
  for candidate in /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
    if [[ -x "${candidate}" ]]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi
[[ -n "${NODE_BIN}" ]] || die "node not found. Install Node 22+ or pass --node /path/to/node"
[[ "${NODE_BIN}" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "node must be a simple absolute path; use scripts/deploy-service.mjs for other paths"
[[ -x "${NODE_BIN}" ]] || die "not executable: ${NODE_BIN}"

node_major="$("${NODE_BIN}" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if [[ "${node_major}" -lt 22 ]]; then
  die "Node 22 or newer is required (${NODE_BIN} reports major version ${node_major})"
fi

echo "Installing the ${SERVICE_NAME} service."
info "prefix   ${PREFIX}"
info "user     ${SERVICE_USER}"
info "env file ${ENV_FILE}"
info "node     ${NODE_BIN}"
echo

# 1. Service user. --system, no login shell, home outside /home so that
#    ProtectHome=true in the unit does not hide the CLI runtime credentials
#    that live under $HOME.
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  info "user ${SERVICE_USER} already exists — left untouched"
else
  useradd --system \
    --home-dir "${SERVICE_HOME}" \
    --create-home \
    --shell /usr/sbin/nologin \
    --comment "IronCrew service account" \
    "${SERVICE_USER}"
  info "created system user ${SERVICE_USER}"
fi

SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"

# The home directory may be missing if the account predates this installer.
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 700 "${SERVICE_HOME}"

# 2. Application directory. The installer does not copy the checkout — you
#    decide how the code gets there (git clone, rsync, deployment tool).
if [[ ! -f "${PREFIX}/server/index.ts" ]]; then
  echo
  echo "warning: ${PREFIX} does not look like an IronCrew checkout" >&2
  echo "         (${PREFIX}/server/index.ts is missing)." >&2
  echo "         Put the application there before starting the service:" >&2
  echo "           git clone <repo> ${PREFIX}" >&2
  echo "           cd ${PREFIX} && pnpm install && pnpm build" >&2
  echo "           chown -R ${SERVICE_USER}:${SERVICE_GROUP} ${PREFIX}" >&2
  echo
fi

# 3. Data and log directories. Only these are writable for the service.
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 750 "${DATA_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 750 "${LOGS_DIR}"
info "data directory ${DATA_DIR}"
info "log directory  ${LOGS_DIR}"

# 4. Environment file. NEVER overwrite an existing one — it holds the running
#    configuration and the bot tokens. This is the single most important line
#    in this script.
ENV_DIR="$(dirname -- "${ENV_FILE}")"
install -d -m 755 "${ENV_DIR}"
if [[ -e "${ENV_FILE}" ]]; then
  info "environment file ${ENV_FILE} exists — kept as is"
else
  install -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 600 "${ENV_TEMPLATE}" "${ENV_FILE}"
  info "created ${ENV_FILE} from the example — EDIT IT before starting"
fi
# Ownership and mode are enforced on every run: the file holds secrets.
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# 5. Unit file. Substitute the shipped defaults with the chosen layout.
TMP_UNIT="$(mktemp)"
trap 'rm -f "${TMP_UNIT}"' EXIT
sed \
  -e "s|^ExecStart=/usr/bin/node |ExecStart=${NODE_BIN} |" \
  -e "s|/etc/ironcrew/ironcrew.env|${ENV_FILE}|g" \
  -e "s|/var/lib/ironcrew|${SERVICE_HOME}|g" \
  -e "s|${DEFAULT_PREFIX}|${PREFIX}|g" \
  -e "s|^User=${DEFAULT_USER}$|User=${SERVICE_USER}|" \
  -e "s|^Group=${DEFAULT_USER}$|Group=${SERVICE_GROUP}|" \
  "${UNIT_TEMPLATE}" >"${TMP_UNIT}"

if [[ -f "${UNIT_PATH}" ]] && cmp -s "${TMP_UNIT}" "${UNIT_PATH}"; then
  info "unit ${UNIT_PATH} already up to date"
  UNIT_CHANGED=0
else
  install -m 644 "${TMP_UNIT}" "${UNIT_PATH}"
  info "installed ${UNIT_PATH}"
  UNIT_CHANGED=1
fi

systemctl daemon-reload
info "systemd configuration reloaded"

# 6. Next steps. The service is not enabled or started here on purpose: that is
#    a decision for the admin, after the environment file is filled in.
cat <<NEXT

Next steps
  1. Configure (at minimum OAUTH_ENCRYPTION_SECRET, DB_PATH, LOGS_DIR, HOST, PORT):
       sudoedit ${ENV_FILE}
  2. Start the service and have it come up at boot:
       sudo systemctl enable --now ${SERVICE_NAME}
  3. Watch it:
       systemctl status ${SERVICE_NAME}
       journalctl -u ${SERVICE_NAME} -f
NEXT

if [[ "${UNIT_CHANGED}" -eq 1 ]] && systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  echo "The unit changed while the service is running — apply it with:"
  echo "  sudo systemctl restart ${SERVICE_NAME}"
fi
