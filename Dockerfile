# ---- base: foundational OS, Node.js, CLI providers ----
FROM node:22-bookworm AS base

# System deps: Chromium for Remotion, curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      curl \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Tell Remotion/Playwright to use system Chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Enable pnpm via corepack (pinned version from package.json)
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

# Install all CLI providers globally
RUN npm i -g \
    @anthropic-ai/claude-code \
    @openai/codex \
    @google/gemini-cli \
    opencode-ai \
    openclaw

WORKDIR /app

# ---- deps: install all dependencies (cached layer) ----
FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- dev: hot-reload development target ----
FROM deps AS dev

ENV HOST=0.0.0.0

# gosu for dropping privileges in the entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Source is mounted at runtime via compose volume, node_modules via named volume.
# Copy source as fallback (overridden by bind mount in compose).
COPY . .

# Ensure node_modules is owned by node so the named volume is writable as non-root
# /data for SQLite+logs, /workspaces for agent project files
RUN chown -R node:node node_modules \
 && mkdir -p /data && chown node:node /data \
 && mkdir -p /workspaces && chown node:node /workspaces

# Mark /workspaces as safe for git so bind-mounted repos owned by the host user
# (different UID) don't trigger "dubious ownership" errors in worktree operations.
RUN git config --system --add safe.directory '*'

COPY scripts/docker-dev-entrypoint.sh /usr/local/bin/docker-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-dev-entrypoint.sh

EXPOSE 8800 8790

# Entrypoint runs as root to fix /workspaces ownership, then drops to node
ENTRYPOINT ["docker-dev-entrypoint.sh"]
CMD ["pnpm", "dev:docker"]

# ---- builder: compile frontend + prepare Remotion ----
FROM deps AS builder

COPY . .

# Build frontend (tsc type-check + vite build)
RUN pnpm build

# Pre-download Remotion Chromium runtime
RUN pnpm exec remotion browser ensure

# ---- production: final runtime image ----
FROM base AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0

# gosu for dropping privileges in the entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Create data + workspaces directories
RUN mkdir -p /data /workspaces && chown node:node /data /workspaces

# Mark /workspaces as safe for git (host-mounted repos may have different UID)
RUN git config --system --add safe.directory '*'

# Copy node_modules (includes tsx needed for pnpm start)
COPY --from=deps /app/node_modules ./node_modules

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy server source (tsx runs TypeScript directly)
COPY --from=builder /app/server ./server

# Copy package.json (needed for pnpm start script)
COPY --from=builder /app/package.json ./

# Copy Remotion browser cache (lives inside node_modules/.remotion/ after `remotion browser ensure`)
COPY --from=builder /app/node_modules/.remotion ./node_modules/.remotion

# Copy remaining config files needed at runtime
COPY --from=builder /app/tsconfig.json /app/tsconfig.node.json ./
COPY --from=builder /app/scripts ./scripts

# Copy AGENTS.md and templates directory
COPY --from=builder /app/AGENTS.md ./
COPY --from=builder /app/templates ./templates/

# Copy production entrypoint (chmod so a Windows clone without filemode also works)
COPY scripts/docker-prod-entrypoint.sh /usr/local/bin/docker-prod-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-prod-entrypoint.sh

# Public assets are baked into dist/ by vite build, but also needed for
# any direct references. They're already in dist/ so no extra copy needed.

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8790/health || exit 1

EXPOSE 8790

# Entrypoint runs as root to fix /workspaces + /data ownership, then drops to node
ENTRYPOINT ["docker-prod-entrypoint.sh"]
CMD ["pnpm", "start"]
