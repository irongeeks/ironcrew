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

# Four eyes on a dangerous approval

Until Phase 5 an approval had exactly one decider: one name, one moment, done.
That is the right shape for the overwhelming majority of approvals — an owner
reads a summary, says yes, work continues. It is the wrong shape for the
handful that can end a company: a sandbox elevation (T-01), a bank transfer, a
Tier-0 change. For those, one person is a single point of both failure and
compromise. Failure: the one owner is on holiday, or misreads the summary at
23:40. Compromise: whoever takes over that one account owns every gate the
product has.

## The quorum lives on the approval, not in a settings page

`crew_approvals.required_approvals` defaults to `1` and is `NOT NULL` with
`CHECK (required_approvals >= 1)`.

The tempting alternative is a company-wide switch: "this installation always
requires two approvals". It is tempting because it is one decision instead of
many, and it is wrong for a reason that is easy to predict and hard to undo.
Most approvals in a working day are routine — a permission change, a
deployment — and a global two-person rule makes each of them wait for a second
human who has nothing to add. Within a fortnight somebody switches the setting
off, and it is off for the bank transfer too. A control that makes ordinary
work impossible is a control that gets removed precisely when it would have
mattered.

So the quorum is a property of the thing being decided, raised per approval:

```
POST /api/crew/approvals/:id/quorum   { required: 2 }     owner only
```

In the Command Center that is the **„Vier Augen verlangen“** button on the
approval card, which appears while the approval is still at a quorum of one and
nobody has voted.

The API enforces that independently, and it has to: a control whose only
constraint lives in a React component is a control anybody can send a request
around. **A quorum can only ever go up.** Lowering it is refused — otherwise
the compromised owner account this whole feature guards against (T-21) would
need exactly one extra request to undo it. Changing it once somebody has voted
is refused, and changing it after the decision is refused, which would rewrite
what that decision required.

Lowering a quorum demanded in error is therefore not an API operation. Reject
the approval and raise a new one: both acts stay in the chain, where a silent
correction would leave neither.

Every approval that predates this feature keeps `required_approvals = 1` and
behaves exactly as it did before. Nothing about the single-operator box
changes.

## One row per person, and the index that makes it true

`crew_approval_reviews` carries `UNIQUE (approval_id, reviewer_id)`.

A quorum counts _people_, not clicks. Without that index the second click from
the same impatient owner — a double submit, a retried request, a refreshed tab
— silently satisfies a two-person rule on its own, which is the exact failure
the rule exists to prevent. The database refuses it; the store turns the
refusal into a readable sentence; the API answers `409
invalid_approval_review`; and the UI removes the buttons entirely once you have
voted, rather than greying them out and inviting the click that produces the
refusal.

With one row per person, "two approvals" can only mean two distinct people.
The four-eyes property is structural, not aspirational.

## N to proceed, one to stop

The two directions are not symmetric, and treating them as if they were is a
real mistake with a real consequence.

> N approvals are needed to proceed. **ONE rejection stops it.**

A quorum to reject would mean that a reviewer who has spotted that the
destination IBAN is wrong cannot stop the payment until a colleague agrees —
and if that colleague is on holiday, the dangerous change proceeds _because
nobody was there to help say no_. Requiring agreement to act is prudence;
requiring agreement to refrain is a defect.

The tally is therefore computed from the rows on every read instead of being
latched into a "quorum reached" flag: a rejection that arrives after the second
approval blocks just as firmly as one that arrives before it. There is no
window in which the gate has been declared open and can no longer be shut.

The panel never shows an outstanding count next to a rejection — "es fehlt noch
1 Zustimmung" beside a refusal would suggest one more yes could still save the
transfer.

## "The person who raised it cannot be the only one who approves it"

Enforced as a _mechanism_, decided elsewhere as a _policy_, and that split is
deliberate.

The mechanism is the UNIQUE index: at most one review per person, so an
approval carrying `required_approvals = 2` cannot be satisfied by one human
however many times they click. Whoever raised it can be at most one of the two.

The policy — which kinds of request deserve that treatment — belongs to whoever
raises the approval, and cannot be resolved by a rule in the table, for two
reasons:

1. `crew_approvals.requested_by` is usually an _agent_ (`agt_cto`), not a
   person. A blanket "the requester may not review" check would therefore
   almost never fire, while looking as though the system were protected.
   Comfort without effect is worse than an acknowledged gap.
2. Where it did fire, it would brick the ordinary installation. A single owner
   who raises their own sandbox elevation would be unable to approve it, and
   there is no second owner to ask — the same bricking argument that makes
   `UserStore` refuse to demote the last active owner.

So a self-approval at a quorum of 1 is recorded honestly and reported as such
(`selfApproved` in the tally), and an approval that must not be decided alone
is raised with `required_approvals = 2`.

## The vote goes through one call

`POST /api/crew/approvals/:id/decide` records the caller's verdict _and_, if
that verdict settles the approval, decides it — in the same call.

They could have been two: one endpoint to vote, and something else to "close"
the approval once enough votes are in. That shape has a failure mode that is
easy to reach and hard to notice — a quorum that is reached and then sits
there, because whatever was supposed to notice it did not run. An approval
everybody has agreed to that is still blocking a task is indistinguishable,
from the board, from one nobody has looked at.

So the status code carries the difference:

| Code  | Meaning                                                           |
| ----- | ----------------------------------------------------------------- |
| `200` | The verdict settled the approval. `approval.status` is final.     |
| `202` | The vote was recorded. The approval is still `pending`.           |
| `409` | You have already voted, or the approval is no longer pending.     |
| `403` | You are not an owner. Viewers and operators may read, never vote. |

`202` rather than `200` for the recorded-but-not-decided case is not
pedantry: a UI that read it as success would tell the owner the transfer is
released while it is still waiting for a second human, which is the one thing
this whole feature exists to prevent.

**`POST /api/crew/change-proposals/:id/decision` answers the same way, and for
the same reason.** A file-change proposal raises an ordinary approval, so an
owner can demand four eyes on a deploy script touching a customer's Tier 0.
That route used to decide the approval directly, which made the quorum
decorative on exactly the change type that most deserves it. It now goes
through the vote like everything else, and answers `202` while the second
reviewer is still missing.

## Reading the vote

```
GET  /api/crew/approvals                 each pending approval, with its tally and reviews
GET  /api/crew/approvals/:id/reviews     one approval's tally and reviews
```

Readable by any signed-in user, not only an owner: who has already looked at a
dangerous change is exactly what the second reviewer needs to know before
adding their own name to it.

Reviews come back with a `reviewer_label` resolved server-side.
`reviewer_id` is a `usr_…`, which is the right thing to _store_ — an account
can be renamed and the audit chain must not change when it is — and the wrong
thing to _show_. It falls back to the id rather than to "Unbekannt": a deleted
account is still evidence, and an id is at least traceable.

## In the audit chain

Every verdict appends `approval.review_approved` / `approval.review_rejected`
with the reviewer's own `usr_…` as `actor_id` — that individuation is the
entire point of the table. `actor_type` stays `"owner"` for a human, per the
rule in the section above.

Two further entries mark the _transitions_, not the state, so exactly one
entry marks the moment the gate could open and one the moment it was shut:

- `approval.quorum_reached` — enough approvals, nobody has rejected. Lists the
  reviewers.
- `approval.quorum_blocked` — the first rejection.
- `approval.quorum_set` — somebody raised (or lowered) the bar, with `from`
  and `to`.

## What is deliberately not here

- **No `abstain` verdict.** An abstention is indistinguishable from not having
  looked yet, and giving it a row would let a reviewer appear in the audit
  trail as having participated without ever taking a position.
- **No named reviewer slots** ("this approval must be reviewed by Anna and
  Bob"). That is an escalation policy, and it needs an on-call rota to be
  usable at all; a count is honest about what this system can actually
  promise.
- **No expiry per review.** The approval already expires as a whole
  (`crew_approvals.expires_at`); a second, finer clock would let a quorum
  silently decay and produce the one outcome nobody wants — a change that
  proceeds because a vote timed out.
- **No automatic quorum by approval type.** Nothing yet says "every
  `bank_transfer` over 5.000 EUR needs two". That rule needs an amount the
  approval does not currently carry as a number, and guessing it out of the
  summary text would be a gate that fails open on a formatting change.

## What this is not

- **Not LDAP or SAML.** OIDC exists now (see below); the other two do not.
  Nobody has asked, and each is a second protocol with its own failure modes
  in the one place that must not have them.
- **Not per-object permissions.** A viewer sees everything a viewer sees.
  Splitting visibility per project would be a second permission system on top
  of the tool grants that already exist.
- **Not a replacement for the shared password.** It still guards the rest of
  the API surface (`/api/ops`, the workflow routes), which is not part of
  IronCrew's own domain.

# Signing in through a directory (OIDC)

The password login stays the default and stays the fallback. What this adds is
a second way to prove _who_, for the installation that already runs a
directory — Authentik, in the case this was written for — where joining and
leaving the company happens once, centrally, and where everybody's second
factor already lives. Two places to switch an account off means one place
somebody forgets, and the account they forget belongs to the person who left.

Nothing here is Authentik-specific. It is the Authorization Code flow with
PKCE against a generic OIDC issuer.

## What it is not

It is not a second kind of principal, a second role model or a second audit
actor. An SSO login ends in exactly the row `crew_sessions` would hold after a
password login, and `actor_id` stays the same `usr_…`. There is one kind of
session in this system and one kind of account; a directory is a way of
proving you are one of them.

## Configuration

```
IRONCREW_OIDC_ISSUER=https://idp.intern.example/application/o/ironcrew/
IRONCREW_OIDC_CLIENT_ID=…
IRONCREW_OIDC_CLIENT_SECRET=…
IRONCREW_OIDC_REDIRECT_URI=https://crew.intern.example/api/crew/auth/oidc/callback
```

Off unless `IRONCREW_OIDC_ISSUER` is set. Setting it without a client id or a
redirect URI refuses to start rather than defaulting: a guessed redirect URI
does not match what is registered at the issuer, so the login fails at the far
end with a message about the client, which is a long way from the variable
that was actually missing.

The redirect URI must match what the issuer has registered, exactly. The
discovery document's own `issuer` is canonical — Authentik's ends in a slash —
and the configured value must agree with it modulo that trailing slash.

## Who gets in — the part that matters

**Default: `refuse`.** A verified `(issuer, subject)` with no row in
`crew_oidc_identities` is refused. No account is created and nothing is matched
on email. The refusal names the issuer and the subject in the log so an owner
can link it in seconds — and only a code reaches the browser, because a
subject identifier does not belong in somebody's history.

That is fail-closed on purpose. An identity provider is a directory of
everyone: staff, contractors, sometimes customers. Treating "the directory
knows you" as "IronCrew trusts you" would hand an account in a system that
holds the company's books to whoever the directory admin adds next.

Two opt-ins exist, both set with `IRONCREW_OIDC_PROVISIONING`:

- `link-verified-email` — attaches a new subject to an **existing active**
  account when the ID token carries a matching address with
  `email_verified: true`. It creates nothing and grants nothing, and it
  consults the email exactly once: from the next login the subject decides. So
  an address changing upstream — even to an owner's — does not move the
  account.
- `create` — creates an account at `IRONCREW_OIDC_CREATE_ROLE`, defaulting to
  `viewer`. **`owner` is refused**, in the type and again at runtime because
  config arrives as JSON: an owner approves irreversible acts, grants tools and
  reads the vault, and anyone able to add a user to the directory would
  otherwise mint one without any IronCrew owner deciding anything. An email
  that already belongs to a local account is a refusal, never a link — that
  would be email-matching through the back door.

Both, and `create`, are additionally gated by the bootstrap rule from
migration 0017: while `crew_users` is empty, SSO provisions nobody. The first
owner is created deliberately, by a human, at the console.

A linked identity whose account is disabled or deleted gets
`account_unavailable`. The local account decides whether it may be used, not
the directory.

## The flow, and the four ways it is attacked

```
GET /api/crew/auth/oidc/start      → 302 to the issuer
GET /api/crew/auth/oidc/callback   → 302 to the app, with a session cookie
```

**The login in progress lives on the server.** Between the redirect out and
the callback back, three secrets have to survive: the PKCE verifier, the nonce
and the state. The obvious place is a cookie, and it is the wrong one — a
cookie is a value anything that can set cookies for this origin can replace,
and swapping the issuer in it would make the callback exchange the code
somewhere else entirely. Signing it would fix that and needs a signing key this
installation does not have. So the pending login stays in memory and the
browser carries an opaque handle. There is nothing in the cookie to tamper
with. The cost, stated plainly: a restart mid-login loses it and the person
starts again, and a second control-plane process would not find the handle —
the provider's replay registry is already in-process for the same reason.

**The pending cookie is `SameSite=Lax`, and that is deliberate.** The callback
arrives as a top-level navigation from the issuer's origin, and a `Strict`
cookie is not sent on one — the login would fail with "no login in progress"
every single time. It holds an opaque handle to a single-use attempt, so `Lax`
costs nothing. The session cookie it produces is still `Strict`.

**Single use, whatever the outcome.** The pending login is consumed by the
first callback that quotes its handle, so a stolen callback URL replayed from
another browser finds nothing.

**No open redirect.** `redirectTo` is only ever a path on this origin.
`//evil.example` and `/\evil.example` are how a protocol-relative URL gets past
a naive `startsWith("/")`, and an open redirect on a login callback is the
classic way to make a phishing link look like it came from the real system.

**ID tokens are verified for real.** Signature against the issuer's JWKS with
one rate-limited refetch on an unknown `kid` (so key rotation works
immediately and a forged `kid` cannot be used to hammer the IdP), plus `iss`,
`aud`, `exp`, `iat` and `nonce`. The accepted algorithms are a whitelist:
`none` is absent because it is the original JWT forgery, and the `HS*` family
is absent because accepting it would let anyone holding the client secret sign
a token as though it were the issuer's.

**Nothing sensitive reaches the browser or a log.** Refusal messages carry the
OAuth `error` code from a validated vocabulary and never `error_description`,
a response body, a token or the code. `GET /auth/status` reports whether a
directory is configured and names the issuer — an operator has to be able to
see which directory this box trusts — and never the client secret.

## What is deliberately not built

- **No `userinfo` call, no access- or refresh-token storage.** The ID token
  answers the only question being asked. Storing an access token would make
  this a client of the directory's API, which is a different feature with a
  different threat model.
- **No RP-initiated or back-channel logout.** Signing out of IronCrew revokes
  the IronCrew session, which is the one this system issued.
- **No dynamic client registration**, and no configuration through the UI. The
  issuer and the client secret arrive through the environment, reviewed like
  every other credential.
- **No unlinking screen yet.** `OidcIdentityStore` has `link`/`unlink` and
  they are tested; nothing in the Command Center calls them, so linking is an
  operator's job at the database today. That is the honest gap in this
  feature.
