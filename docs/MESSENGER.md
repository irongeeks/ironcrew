# Messenger

IronCrew could already tell you something over Telegram or Discord. It could
not hear you. The messenger ingress closes that loop: the owner talks to their
executive assistant in a chat app, and the EA answers back in the same chat.

Two channels ship today — **Telegram** and **Discord** — and both are the
receiving half of integrations whose sending half already existed.

## The shape of it

```text
  crew_messenger_pairings   who may talk to the EA, and with what authority
        │
  crew_external_events      every inbound message, recorded exactly once
        │
        ├─ role "owner"  →  handleCeoMessage(), i.e. the CEO speaking
        └─ role "guest"  →  an `inbox` task, fenced as third-party content
```

## Two directions, two contracts

`NotificationChannel` sends; `MessengerChannel` receives. They are separate
contracts rather than one object with a `poll()` bolted on, because the two
directions have genuinely different trust properties:

- **Outbound is fan-out with no identity.** A channel takes an
  already-created, already-audited notification and pushes it at a webhook or
  a chat id. Failure is best-effort and never blocks the flow that triggered
  it.
- **Inbound carries a sender, and that sender decides whether the message is
  acted on at all.** Every `InboundMessage` is unauthenticated text from
  outside the company until someone has matched its `senderId` against a
  grant.

Fusing them would mean one object where half the methods are safe to call
anywhere and half return attacker-controlled data, with nothing in the type
to say which is which. Kept apart, a component that only sends cannot
accidentally hold a source of untrusted input.

## Pairing — the answer is no until the owner says otherwise

A bot token is not a secret. Anyone who finds the bot can message it. So the
first question about an inbound message is never what it says, it is who sent
it, and `MessengerPairingStore.resolve()` answers that before anything else
happens.

An **unknown sender** produces a `pending` row with a fresh six-digit code,
and the only thing they get back is that code:

```text
IronCrew: Dieser Zugang ist noch nicht freigegeben. Code für die Freigabe: 041273
```

No task appears, no EA turn runs, nothing is routed. The owner accepts the
request in the Command Center — where they can see who is asking — and only
then does the row become `active`.

The code is **short-lived** (10 minutes, `PAIRING_CODE_TTL_MS`) and is
**cleared on accept**: `pairing_code` becomes `''` and `code_expires_at`
becomes `NULL`, so an accepted pairing carries no code to reuse. A stranger
who waited too long gets a fresh code on their next message rather than a
dead row an operator has to delete by hand.

The code proves nothing on its own. It is a handle for the owner to point at
the right stranger, not a password — which is also why it is deliberately
absent from the audit entry `messenger.pairing_requested`: a log that carries
the code hands it to anyone who can read the log.

The sender's display name is attacker-chosen, so it goes through
`sanitiseLine()` before it is ever shown next to a decision the owner is about
to make.

One row per person per channel kind (`UNIQUE (company_id, channel_kind,
sender_id)`). A second Telegram account is a second row and has to be paired
on its own.

## `owner` vs `guest` — the column that is authority, not a label

| role    | status   | what an inbound message does                             |
| ------- | -------- | -------------------------------------------------------- |
| —       | pending  | a pairing prompt, and nothing else                       |
| —       | blocked  | nothing at all, not even a reply                         |
| `guest` | active   | an `inbox` task, quoted as third-party content           |
| `owner` | active   | `handleCeoMessage()` — speaks with the CEO's authority   |

**`owner`** reaches `handleCeoMessage()`, which is the whole point: that is
the owner talking to their own EA. That path treats its text as the owner
speaking and can delegate work immediately. So `owner` is not a label on a
contact, it is the authority to act as the CEO through a chat app, and it is
only ever granted by the owner in the Command Center. The reply the EA
produces goes straight back into the chat.

**`guest`** is a stranger with a name, and is routed exactly like incoming
mail (see [`MAIL.md`](./MAIL.md) and `THREAT_MODEL.md` T-10):

- the text is wrapped by `wrapUntrusted()` as `kind: "Chat-Nachricht"`,
  naming the sender as its source,
- `triage()` classifies risk level and sensitivity — as a classifier, never
  as an instruction interpreter,
- a task is created with `status: "inbox"` (never `ready`, so it does not
  enter the claimable queue and no agent picks it up on its own) and
  `createdBy: "messenger:<kind>:<senderId>"`,
- the sender is told their message is in the inbox, and nothing more.

The two roles exist precisely so that this distinction is a column someone
can look at, rather than a branch someone has to remember. Accepting is
audited as its own action depending on which was granted:
`messenger.owner_granted` or `messenger.pairing_accepted`.

## Block, revoke, unblock

Three different acts, three endpoints, three audit actions — because an
operator reading the log has to be able to tell them apart.

| action    | resulting status | resulting role | audited as                     |
| --------- | ---------------- | -------------- | ------------------------------ |
| `block`   | `blocked`        | `guest`        | `messenger.pairing_blocked`    |
| `revoke`  | `pending`        | `guest`        | `messenger.pairing_revoked`    |
| `unblock` | `pending`        | `guest`        | `messenger.pairing_revoked`    |

**`block`** refuses a sender now and in future. A blocked sender gets nothing
at all — not even the courtesy of knowing they are blocked, which would only
tell them to try again from another account.

**`revoke`** takes a sender back to `pending` with a fresh code. "This person
should no longer speak for me" is not the same statement as "I do not want to
hear from this person", and the audit entry records the `previousRole` that
was taken away.

**`unblock` returns to pending rather than restoring what was granted.** It is
`revoke` applied to a blocked row, deliberately: un-refusing a sender is a
different decision from re-granting them CEO authority, and the second must
never ride along with the first. The owner accepts again, choosing the role
again, with the same deliberateness as the first time.

Accepting a blocked pairing is refused rather than silently unblocking it —
**409 `invalid_pairing_transition`**, a state answer rather than a complaint
about the request.

## Configuration

Inbound and outbound are configured **separately**, even where they share a
provider:

| variable                     | direction | what it does                                 |
| ---------------------------- | --------- | -------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         | inbound   | registers the Telegram messenger channel     |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | outbound | the existing notification channel |
| `DISCORD_BOT_TOKEN` + `DISCORD_INBOUND_CHANNEL_ID` | inbound | registers the Discord messenger channel |
| `DISCORD_WEBHOOK_URL`        | outbound  | the existing notification channel            |

The Telegram bot token is the same value in both directions, but the outbound
channel additionally needs `TELEGRAM_CHAT_ID` — it has one fixed destination,
while the inbound channel learns the chat from whoever writes to it.

Discord's two directions are not even the same kind of thing. Outbound is a
**webhook**: a URL that can post into a channel and has no identity and cannot
read. Inbound needs a real **bot** with Read Message History on the channel
named by `DISCORD_INBOUND_CHANNEL_ID`. A webhook URL cannot receive anything,
which is why there is no way to derive one configuration from the other.

Unconfigured means **not registered**, the same posture every other optional
integration takes: `GET /api/crew/messenger-channels` reports what exists
rather than wrapping a channel that could never connect.

Registering a channel does not open the door. Nothing is fetched until
something calls the poll endpoint, and nothing an unknown sender writes is
acted on until the owner has paired them.

## Polling — pulled, never pushed

There is **no background scheduler**. Messages arrive when something calls:

```http
POST /api/crew/messenger-channels/:kind/poll
```

the same way mailboxes are polled by `POST /api/crew/mailboxes/poll-due`
rather than by a loop nobody can see. The response says what happened:

```json
{ "received": 4, "handled": 1, "pairingPrompts": 1, "taskIds": ["tsk_…"] }
```

`taskIds` names what a guest's messages became, so the caller can announce
those tasks to the board rather than leaving them to be discovered on the
next reload.

A poll **consumes the channel's cursor**, which is why this is the only
endpoint that advances it — and why `testConnection()` deliberately never
polls to answer. A "does this work?" click that swallowed messages nobody had
seen yet would be worse than no button.

The cursors are the providers' own: Telegram's `getUpdates` offset (one
number that both selects the next batch and acknowledges the previous one),
Discord's newest snowflake passed back as `after`. Both live in memory, so a
restart can produce a redelivery — which is what the external event log is
for.

## Every message is recorded once

Before anything acts on a message, `pollMessengerChannel()` records it in
`crew_external_events` under `source_kind: "messenger:<kind>"`,
`source_id: <chatId>` and the provider's own stable `externalId`. If the row
already existed, `delivery_count` rises and the message is skipped: a repeat
was already answered once, and answering again would double every task the
first delivery produced.

`seen` and `handled` are separate states on purpose. A process that dies
between recording and acting leaves an event recorded but unhandled, which is
exactly what `GET /api/crew/external-events?unhandled=true` finds.

`POST /api/crew/external-events/:id/replay` clears the handled marker so the
event is processed again. It never rewrites the stored payload: a replay means
"do this again with what actually arrived", not "do this with what someone
typed afterwards".

## The Discord limitation, stated plainly

Discord's supported way to receive messages — and the only way to receive
arbitrary DMs — is a **Gateway websocket**: a process that stays connected,
heartbeats, resumes after disconnects and holds session state. This channel
does not do that. It polls one channel over the REST API:
`GET /channels/{id}/messages?after={snowflake}`.

What that buys and what it costs:

- It works for a **dedicated channel** — a crew channel in a guild the bot was
  invited to, or a single DM channel whose id is known and configured. That is
  the case IronCrew actually needs: an operator talks to their crew in one
  place.
- It does **not** work for arbitrary DMs. Without the Gateway, a bot is never
  told that a DM channel it has never seen exists, so a user messaging the bot
  out of the blue is invisible here.
- Latency is the polling interval, not milliseconds, and the bot needs Read
  Message History on the channel.

The trade is deliberate: no persistent connection means no reconnect logic, no
session resumption, no long-lived process to supervise, and a channel whose
entire behaviour is testable through an injected `fetch`. Arbitrary DMs need a
Gateway client, which is a different and much larger component.

Messages authored by bots are skipped — including this channel's own replies,
which would otherwise come back on the next poll and be answered again.

Telegram has its own edges, all of them dropped rather than half-handled:
`channel_post` has no `from`, so there is nobody to authorise; photos,
stickers and joins carry no text to act on; an edit is treated as a new
message, and the caller decides by `externalId` whether it has already acted.

## Inbound text is untrusted input

The identity check decides *whether* a message is acted on. The sanitising
decides what the text is allowed to be while that happens.

- **Control tokens are stripped at the channel boundary**, before the message
  ever leaves `poll()` — `<|im_start|>`, `<|start_header_id|>`,
  `<start_of_turn>`, `[INST]`, `<<SYS>>`, a line beginning `Human:`. Newlines
  survive; a chat message is allowed to have lines. Overlong messages are
  truncated with a visible ellipsis.
- **`senderId` is what is matched against a pairing, never `senderName`**,
  which the sender picks themselves and can change at will. The display name
  is cosmetic and flattened to a single sanitised line.
- **Guest text is fenced** with `wrapInboundForPrompt()` / `wrapUntrusted()`
  before it becomes a task description, naming the sender so the model — and
  the operator reading the transcript — can see whose text it is. The fence is
  unforgeable; see [`MAIL.md`](./MAIL.md) for how and why.
- **Owner text is not fenced.** It is the owner talking, and it reaches the
  CEO path as such. That is precisely why role `owner` is a deliberate grant
  and not something a first message can earn.
- **Replies are plain text.** No `parse_mode`, no markup: escaping
  agent-written output correctly on every path is a bug waiting to happen, and
  a missed escape turns an answer into markup or into a provider error the
  operator sees instead of the answer. Replies are capped at the provider's own
  limit (4096 Telegram, 2000 Discord).

## Endpoints

```http
GET  /api/crew/messenger-channels                  # registered kinds + reachability
POST /api/crew/messenger-channels/:kind/poll       # the only thing that advances the cursor

GET  /api/crew/messenger-pairings
POST /api/crew/messenger-pairings/:id/accept       { "role": "owner" | "guest" }
POST /api/crew/messenger-pairings/:id/block
POST /api/crew/messenger-pairings/:id/unblock
POST /api/crew/messenger-pairings/:id/revoke
```

A provider that refuses a call answers **502 `messenger_unreachable`** — the
request was fine, someone else's server was not. An illegal pairing transition
answers **409 `invalid_pairing_transition`**.

Every pairing decision broadcasts `crew_messenger_changed`, and so does a poll
that actually received something, so the Command Center shows a new pairing
request without anyone reloading.

See `THREAT_MODEL.md` **T-13** (messenger ingress) and **T-14** (granting
owner authority over a chat app).
