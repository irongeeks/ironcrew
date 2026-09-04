# Identity

Who is asking, what they may do, and whose name ends up in the audit log.

## Why this exists

Until now `/api/crew` had one credential: a shared password (or a bearer
token) that said "you may talk to this API". It said nothing about _who_, so
every audit entry named the constant `"ceo"`.

An audit log whose every entry names the same fictional actor proves the wrong
thing carefully. It looks like accountability and provides none: it cannot
answer "who approved that transfer", it cannot show that two people were
involved, and it cannot be used to notice that one account is doing things
nobody expected. On a single-operator machine behind loopback that is
defensible. The moment a second person, a tailnet address or a colleague on
holiday cover is involved, it is not.

## The two layers

They answer different questions, and keeping them apart is what lets identity
arrive without breaking an installation that has no users.

| Layer                               | Question                          | Where                                   |
| ----------------------------------- | --------------------------------- | --------------------------------------- |
| `server/security/auth.ts`           | may this client talk to the API?  | shared password, bearer, remote session |
| `server/ironcrew/auth/crew-auth.ts` | who is this and what may they do? | `/api/crew` only                        |

**One login, not two.** A crew session satisfies the outer layer as well: it
names a person, it expires, and it can be revoked, so it is strictly the
stronger credential. Asking for the shared password on top would keep that
password in circulation, which is precisely what accounts are meant to end.

## The bootstrap rule

While `crew_users` is empty, the installation is pre-identity: the shared
password is the only credential there is, and every request acts with full
rights, exactly as before. The moment the first account exists, that stops —
`/api/crew` then requires a real session, because from then on there _is_ a
person to name.

This is checked per request against the live table, not cached at startup: the
switch happens in the same instant as the first `POST /api/crew/users`.

Creating that first account is the one unauthenticated write in the system,
and it is only open while no account exists. It defaults to `owner`, because
an installation whose only account is a viewer has nobody who can approve
anything or create a new owner — it is bricked, and no amount of "the operator
should have known better" un-bricks it. The other end of that rule lives in
`UserStore`: it refuses to demote, disable or delete the last active owner.

## Roles

Three, deliberately coarse. Three roles that map to real jobs beat a
permission matrix nobody maintains.

| Role       | May                                                                      |
| ---------- | ------------------------------------------------------------------------ |
| `viewer`   | read everything                                                          |
| `operator` | everything a running company needs: tasks, projects, meetings, mail, ... |
| `owner`    | plus the decisions that hand out authority                               |

"Hands out authority" is the dividing line, not "is dangerous". An owner is
needed for:

- **approvals** (`POST /approvals/:id/decide`) — approving is the owner's
  alone, per `docs/THREAT_MODEL.md` T-01,
- **change proposals** — the same decision, for file writes,
- **vault secrets** — a `SecretRef` is a key to something,
- **tool grants** — deciding what an agent may do at all,
- **messenger pairings** — granting role `owner` to a chat is granting the
  ability to act as the CEO from a phone,
- **user administration** — deciding who may use the system.

The guard is expressed once, by method: reading needs `viewer`, changing needs
`operator`, and the endpoints above say `ownerOnly` for themselves. A
per-route list of "which endpoints need a login" is a list somebody forgets to
extend, and the endpoint they forget is the one that ends up open.

## Sessions

- The token is 32 bytes of CSPRNG output, returned exactly once. Only its
  SHA-256 is stored, so a stolen database file yields no usable session.
- Seven days, and revocable: `resolve` re-reads the account on every request,
  so disabling a user cuts their existing sessions off immediately rather than
  at the end of the TTL.
- IP and user-agent are recorded at login and compared on each request, but a
  mismatch is logged and never fails the request. Mobile clients roam across
  cell, wifi and VPN; hard-binding would force constant re-logins without
  meaningfully raising the bar for someone who already holds the cookie.
- Changing your own password ends every other session of that account. If the
  reason for the change was a suspected theft, leaving the thief signed in
  defeats it.

The cookie is `ironcrew_session`, `HttpOnly`, `SameSite=Strict`, and `Secure`
whenever the request arrived over HTTPS. Scripts may send the same token as
`x-ironcrew-session` instead — a cookie is a transport, not a second class of
credential.

## Logging in

```
POST /api/crew/auth/login      { email, password }   → sets the session cookie
POST /api/crew/auth/logout                            → revokes it server-side
GET  /api/crew/auth/status                            → bootstrap / who am I
GET  /api/crew/auth/sessions                          → your own devices
DELETE /api/crew/auth/sessions/:id                    → end one of them
POST /api/crew/auth/password   { currentPassword, newPassword }
```

An unknown account, a wrong password and a disabled account all answer
`401 invalid_credentials` with the same body. Which of the three it was is
exactly what an attacker is probing for. The store equalises the work as well:
an unknown email still costs a full scrypt verification, so "instant no" never
means "no such user".

Repeated failures from one address lock that address out, reusing the same
lockout the legacy password login already has rather than growing a second,
subtly different one.

## The audit log

`actor_id` is now a real `usr_…` for anything a signed-in person does. It
stays `"ceo"` in exactly two places, and both are honest:

- a pre-identity installation, where nobody has a name yet, and
- work with no person behind it — the scheduler, a routine, the messenger
  owner path.

`actor_type` stays `"owner"` for a human even when that human is an operator.
`crew_audit_events.actor_type` carries a CHECK constraint and the table is an
append-only hash chain; adding a value would mean rebuilding the chain whose
whole purpose is that it cannot be rebuilt. So the type keeps its original
meaning of "a human at the console", and the role travels in the entry's
details.

## What this is not

- **Not SSO.** No OIDC, no LDAP, no SAML. A self-hosted single-operator
  system does not need an identity provider, and adding one would add a
  dependency that must be online for anyone to log in.
- **Not per-object permissions.** A viewer sees everything a viewer sees.
  Splitting visibility per project would be a second permission system on top
  of the tool grants that already exist.
- **Not a replacement for the shared password.** It still guards the rest of
  the API surface (`/api/ops`, the workflow routes), which is not part of
  IronCrew's own domain.
