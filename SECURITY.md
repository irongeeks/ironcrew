# Security Policy

## Supported Versions

Security fixes are primarily applied to the latest stable line.

| Version | Supported |
| ------- | --------- |
| 2.5.x   | Yes       |
| < 2.5.0 | No        |

## Reporting a Vulnerability

Please do not open public GitHub issues for security vulnerabilities.

Use GitHub Private Vulnerability Reporting:

- https://github.com/irongeeks/ironcrew/security/advisories/new

If private reporting is unavailable in your environment, open a minimal issue without exploit details and ask a maintainer for a private channel.

## Response Expectations

- Initial triage target: within 72 hours
- Follow-up status updates: provided during investigation
- Fix publication: coordinated with impact and patch readiness

## Scope

Typical in-scope areas include:

- Auth/session boundaries
- OAuth token handling and encryption flows
- `/api/inbox` secret validation and webhook handling
- Command execution paths, worktree operations, and update flows
- Secrets handling in logs/configuration

## Deployment Hardening Notes

### Loopback trust model

The built-in rate limiters (`global`, `strict`, `auth`, `login`) in
`server/security/rate-limit.ts` intentionally **skip requests that originate
from the loopback interface** (`127.0.0.1`, `::1`). This is safe for the
default single-user local workflow but has implications when exposing the
server beyond localhost:

- **Tailscale / VPN setups** — The server still sees the Tailscale peer IP
  as non-loopback, so rate limits apply. Your login endpoint is brute-force
  protected for remote peers even with password auth enabled.
- **Reverse proxy on the same host** — If you run a proxy (nginx, caddy)
  that terminates TLS and forwards to `127.0.0.1:8790`, **the limiter will
  skip all traffic** because the proxied request appears loopback. Either
  bind the server directly to the proxy-facing interface, or enable
  `trust proxy` and ensure `X-Forwarded-For` is set, so the limiter sees
  the real client IP. This is the most common misconfiguration — double-
  check it before exposing the server publicly.
- **Docker host-network mode** — Containers sharing the host network will
  be treated as loopback. Use bridge networking or bind to a specific
  Tailscale/LAN IP when you want limits enforced.

Environment overrides: `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_STRICT_MAX`,
`RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_LOGIN_MAX` (and the matching
`*_WINDOW_MS` variables) tune the thresholds per window.

### Content-Security-Policy

In production builds (`NODE_ENV=production`) the CSP `connect-src` directive
only permits `wss:` connections. Development builds additionally permit
`ws:` so the Vite dev server works. If you reverse-proxy the production
server over plain HTTP for some reason, the browser will block the
WebSocket upgrade — terminate TLS at the proxy and proxy `wss://` through
to the server.
