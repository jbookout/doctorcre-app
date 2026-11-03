# Queued asks

The app half of WR617.S8 targets `submit-doc-request`, contract `doc-request.v1`.
This contract is proposed, not deployed. The deployed verb list inspected for
this card contains `add-doc-conversation-turn`, but that verb is authority-only.
No app code calls it or `submit-email-draft` for an ask.

The new partner-only verb accepts exactly `idempotency_key` (UUID v4),
`conversation_id` (UUID), and `body` (nonblank, at most 20,000 characters).
The actor comes from the authenticated browser session and CSRF binding.
The producer must verify conversation access and append a human turn with
`msg_id = idempotency_key`, retaining one immutable request and receipt per
actor/key. A replay returns the original receipt; changed arguments must refuse.
The receipt is committed atomically with the turn. No assistant role or actor
field is caller-controlled. Existing request completion handles the answer.

Acceptance returns `ok: true`, `contract: "doc-request.v1"`,
`status: "accepted"`, `conversation_id`, `idempotency_key`, and
`request_msg_id` equal to the key. A verified pre-acceptance refusal returns
the same contract and identifiers with `status: "refused"` and a fixed `reason`.
It must use a successful tool envelope, allowing the app to validate it.
All other responses and transport errors are unknown, including auth errors
after dispatch. The app retains the frozen request and replays the same key.
Exactly-once means one canonical human turn, not one HTTP attempt.

Each ask has its own device-storage record, scoped to actor and conversation.
Draft text has a separate version; queue cleanup compares the full persisted
snapshot so another tab's newer draft survives. Accepted records remain as
receipts. Reopening a submitting record makes its uncertainty explicit.
Reconnect retries queued and unknown asks, never refused or accepted asks.
Storage failure prevents dispatch. Session invalidation stops controllers.
An offline reload waits for session verification before revealing saved asks.
Removing browser data removes local queued asks. This is device persistence.

Two designs were considered. Extending the in-memory command dock would lose
the request on reload. A persisted per-request outbox keeps frozen requests
independent across tabs and uses server idempotency for replay safety. The
outbox owns persistence and transitions; the React composer owns presentation.
The existing lazy host entry exports the mount function because an open PR
owns bundle registration. Cold Node imports never import a generated entry.

The CARR follow-up needs `mcp-server/src/doc-conversation.js`, a migration for
the partner-only definer and actor-scoped idempotency receipt if the existing
append function cannot provide these guarantees, PostgreSQL tests in
`mcp-server/test/doc-conversation-postgres.test.mjs`, a versioned contract, and
regeneration of `mcp-server/src/scac-mutation-registry.current.generated.js`.
Check `tools.js` registry-source wiring before adding any new registration.
CARR PR 2933 owns the generated registry at this card's opening check.
