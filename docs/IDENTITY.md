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
approval card. It only appears while the approval is still at a quorum of one
and nobody has voted — raising the bar after a decision would rewrite what that
decision required, which is the one thing the audit chain must never allow.

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

- **Not SSO.** No OIDC, no LDAP, no SAML. A self-hosted single-operator
  system does not need an identity provider, and adding one would add a
  dependency that must be online for anyone to log in.
- **Not per-object permissions.** A viewer sees everything a viewer sees.
  Splitting visibility per project would be a second permission system on top
  of the tool grants that already exist.
- **Not a replacement for the shared password.** It still guards the rest of
  the API surface (`/api/ops`, the workflow routes), which is not part of
  IronCrew's own domain.
