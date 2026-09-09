# Supertest 7.2.2: listener address family

`supertest@7.2.2.patch` keeps HTTP test requests in the bound server's address
family. Upstream builds every temporary URL with `127.0.0.1`, even when the
listener is bound to IPv6. Separate IPv4 and IPv6 listeners can own the same
port, so this can send a request to an unrelated test server and produce a
spurious 404. A server bound only to `::1` is also unreachable through IPv4.

The patch uses the actual bound address, maps wildcard addresses to their
matching loopback address, and brackets IPv6 URL hosts. It changes no test
expectations, retries, timeouts, or application routes.

`server/test/supertest-listener-isolation.test.ts` deterministically reproduces
the collision and tests IPv6 loopback, IPv4 loopback, and IPv4 wildcard listeners.
The unpatched package fails two cases; the patched package passes all four.

pnpm pins the patch in `pnpm-workspace.yaml` and `pnpm-lock.yaml`. Docker copies
the patch before its frozen dependency installation. When upgrading Supertest,
check whether upstream handles these cases and remove the patch only when this
regression suite passes with the unpatched package.
