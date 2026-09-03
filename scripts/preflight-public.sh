#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

pass() { printf '[PASS] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; failures=$((failures + 1)); }

echo "== OctoOffice public release preflight =="

for cmd in git rg node pnpm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo
  echo "Preflight aborted due to missing dependencies."
  exit 1
fi

required_ignore_entries=(
  ".env"
  ".env.*"
  "!.env.example"
  "logs/"
  "*.sqlite"
  ".direnv/"
  "*.pem"
  "*.key"
  "*.p12"
  "*.pfx"
  "credentials.json"
  "secrets*.json"
)
for entry in "${required_ignore_entries[@]}"; do
  if ! grep -Fxq "$entry" .gitignore; then
    fail ".gitignore missing required entry: $entry"
  fi
done
if [ "$failures" -eq 0 ]; then
  pass ".gitignore contains required public-release entries"
fi

blocked_tracked=(
  ".env"
  ".env.local"
  ".env.production"
  "octooffice.sqlite"
  "octooffice.sqlite-shm"
  "octooffice.sqlite-wal"
)
for path in "${blocked_tracked[@]}"; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    fail "Sensitive runtime file is tracked: $path"
  fi
done

tracked_env_files="$(git ls-files | rg '^\.env($|\.)' | rg -v '^\.env\.example$' || true)"
if [ -n "$tracked_env_files" ]; then
  fail ".env runtime files are tracked (must remain local-only)"
  printf '%s\n' "$tracked_env_files"
else
  pass "No .env runtime files are tracked"
fi

tracked_key_files="$(git ls-files | rg '(^|/)(id_rsa|id_ed25519)$|\.(pem|key|p12|pfx|cer|crt)$|(^|/)credentials\.json$|(^|/)secrets[^/]*\.json$' || true)"
if [ -n "$tracked_key_files" ]; then
  fail "Credential/key files are tracked"
  printf '%s\n' "$tracked_key_files"
else
  pass "No credential/key files are tracked"
fi

if git ls-files | rg -q '^logs/'; then
  fail "logs/ contains tracked files"
else
  pass "No runtime logs are tracked"
fi

secret_pattern='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----)'

working_tree_hits="$(mktemp)"
if git grep -nI -E "$secret_pattern" -- . ':(exclude).env.example' >"$working_tree_hits" 2>/dev/null; then
  fail "Potential secret pattern found in tracked working tree files"
  cat "$working_tree_hits"
else
  pass "No high-confidence secret patterns in tracked working tree files"
fi
rm -f "$working_tree_hits"

history_hits="$(mktemp)"
while IFS= read -r rev; do
  git grep -nI -E "$secret_pattern" "$rev" -- . ':(exclude).env.example' >>"$history_hits" 2>/dev/null || true
done < <(git rev-list --all)

if [ -s "$history_hits" ]; then
  fail "Potential secret pattern found in git history"
  cat "$history_hits"
else
  pass "No high-confidence secret patterns in git history"
fi
rm -f "$history_hits"

required_env_vars=(
  "PORT"
  "HOST"
  "OAUTH_ENCRYPTION_SECRET"
  "SESSION_SECRET"
  "DB_PATH"
  "LOGS_DIR"
  "OAUTH_BASE_URL"
  "OAUTH_GITHUB_CLIENT_ID"
  "OAUTH_GITHUB_CLIENT_SECRET"
  "OAUTH_GOOGLE_CLIENT_ID"
  "OAUTH_GOOGLE_CLIENT_SECRET"
  "GEMINI_OAUTH_CLIENT_ID"
  "GEMINI_OAUTH_CLIENT_SECRET"
  "OPENAI_API_KEY"
  "GOOGLE_CLOUD_PROJECT"
  "GOOGLE_CLOUD_PROJECT_ID"
)
missing_env_vars=()
for var in "${required_env_vars[@]}"; do
  if ! rg -q "^[# ]*${var}=" .env.example; then
    missing_env_vars+=("$var")
  fi
done

if [ "${#missing_env_vars[@]}" -gt 0 ]; then
  fail ".env.example missing variables: ${missing_env_vars[*]}"
else
  pass ".env.example covers required runtime variables"
fi

env_placeholder="__CHANGE_ME__"
placeholder_vars=(
  "OAUTH_ENCRYPTION_SECRET"
  "SESSION_SECRET"
  "OAUTH_GITHUB_CLIENT_ID"
  "OAUTH_GITHUB_CLIENT_SECRET"
  "OAUTH_GOOGLE_CLIENT_ID"
  "OAUTH_GOOGLE_CLIENT_SECRET"
  "GEMINI_OAUTH_CLIENT_ID"
  "GEMINI_OAUTH_CLIENT_SECRET"
  "OPENAI_API_KEY"
  "GOOGLE_CLOUD_PROJECT"
  "GOOGLE_CLOUD_PROJECT_ID"
)
placeholder_mismatches=()
for var in "${placeholder_vars[@]}"; do
  if ! rg -q "^[# ]*${var}=\"${env_placeholder}\"$" .env.example; then
    placeholder_mismatches+=("$var")
  fi
done

if [ "${#placeholder_mismatches[@]}" -gt 0 ]; then
  fail ".env.example placeholder format mismatch (expected \"${env_placeholder}\"): ${placeholder_mismatches[*]}"
else
  pass ".env.example uses a consistent placeholder format for key variables"
fi

if pnpm run build >/tmp/octooffice-preflight-build.log 2>&1; then
  pass "Build succeeded"
else
  fail "Build failed (see /tmp/octooffice-preflight-build.log)"
  tail -n 80 /tmp/octooffice-preflight-build.log || true
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "Preflight FAILED with $failures issue(s)."
  exit 1
fi

echo "Preflight PASSED. Repository is ready for final human review before public release."
