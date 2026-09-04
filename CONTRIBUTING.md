# Contributing to IronCrew

Thanks for contributing.

## Branch Model

- `main`: release/stable branch (maintainers only, protected)
- `dev`: integration branch for day-to-day PRs (protected)
- `feature/*`, `fix/*`, `docs/*`, `chore/*`: working branches from contributors/forks
- `hotfix/*`: emergency production fixes (maintainers), merged to `main` first, then back-merged to `dev`

## PR Target Rules

- **External contributors:** open PRs to `dev` for feature/chore work; documentation-only PRs may target `main`.
- **Maintainer normal work:** open PRs to `dev`, then promote to `main` via a release PR.
- **Maintainer hotfix / release polish:** direct PRs to `main` are allowed at maintainer discretion (e.g. docs fixes, release-readiness polish, production incidents). After any direct-to-`main` merge, back-merge `main -> dev` to keep branches in sync.
- **When in doubt, target `dev`.** A maintainer will retarget if `main` is more appropriate.

## Review and Merge Rules

- Use PR-only merges for both `main` and `dev` (no direct pushes)
- Require at least 1 approval before merge
- Require CI checks to pass before merge
- Prefer `Squash and merge` for a clean history

## Release Flow

1. Feature/fix PRs merge into `dev`
2. When stable, open release PR `dev -> main`
3. After merge to `main`, tag/release as needed
4. Keep `dev` synced with any direct hotfix merged to `main`

## Suggested GitHub Branch Protection

Configure both `main` and `dev`:

- `Require a pull request before merging`
- `Require approvals` (recommended: 1+)
- `Require status checks to pass before merging`
- `Restrict direct pushes`

## Development Environment

### Option 1: Docker (no local Node/pnpm required)

```bash
cp .env.example .env   # fill in secrets
docker compose --profile dev up --build
# Web UI: http://localhost:8800 | API: http://localhost:8790
```

### Option 2: Local (requires Node >= 22, pnpm)

```bash
bash install.sh   # macOS/Linux (or install.ps1 on Windows)
pnpm dev
```

## Quick Commands

Create a working branch:

```bash
git checkout dev
git pull origin dev
git checkout -b feature/my-change
```

Push and open PR to `dev`:

```bash
git push origin feature/my-change
gh pr create --base dev --fill
```

Hotfix back-merge (`main -> dev`):

```bash
git checkout dev
git pull origin dev
git merge origin/main
git push origin dev
```
