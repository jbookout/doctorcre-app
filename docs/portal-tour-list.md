# Tour List and sign out

Card: WR227.S13.J1

## System design

The module owns one browser's selection draft and request lifetime. S10 owns routing, package validation, common types and bundling. S9 owns transport, CSRF and session endpoints. `TourList` accepts a validated publication's property projection and an injected controller. `createTourList` owns asynchronous transitions. A React-only hook was considered; the controller keeps races testable without rendering. No upload, CARR mutation or partner keep/use workflow exists here.

Capacity and storage access are linear in property count at current and tenfold load. DOM rendering breaks first. One whole-list read avoids N+1 and fan-out. No queue, polling, persistent cache or automatic retry exists. Private drafts live in memory and clear on expiry, sign out and disposal. Calls are single-flight with cancellation and a 15-second deadline. One failed call opens an explicit failure state with manual retry, and its status is the user alert. Server rate limits belong to S9. Uncertain saves reuse the exact frozen request and idempotency key. Conflict refuses writes until explicit discard and reload. Partial or unrecognizable receipts remain uncertain.

The injected ports read `{version, selected, notes}` and save the same shape plus `idempotency_key`. The save receipt must match the submitted IDs and notes and advance its version. S9 maps 409 and 401 to status-bearing errors. `signOut` invokes `POST /<slug>/auth/logout`, obtaining CSRF through `GET /<slug>/auth/status` as needed. `clearPrivateState` retires host package/session memory. `returnToGate` retires the shell after acknowledged logout or expiry. A logout failure clears private memory but reports that server revocation is uncertain. No transport or router is duplicated here.

The throughput checkpoint is pinned source and overlap inspection first, then one worker for model/tests/UI, then sequential verification. Parallel workstreams are n/a for this one-owner slice. There are no shared file writes.

## Statechart

```mermaid
stateDiagram-v2
  [*] --> loading
  loading --> ready: read accepted
  loading --> unavailable: read fails
  unavailable --> loading: retry
  ready --> dirty: edit
  dirty --> saving: save proposal
  saving --> ready: exact receipt
  saving --> conflict: version conflict
  saving --> uncertain: timeout or unknown receipt
  uncertain --> saving: retry exact request
  conflict --> loading: confirm discard and reload
  dirty --> loading: confirm discard and reload
  ready --> signing-out: sign out
  dirty --> signing-out: confirm discard
  signing-out --> signout-uncertain: failure
  signout-uncertain --> signing-out: retry
  signing-out --> expired: logout accepted
```

All live states can expire or dispose. Retirement aborts requests and ignores late responses. The model abstracts transport and property data. Controller tests cover concrete values and browser tests cover rendering. The host should keep the controller above route switches to retain unsaved drafts. S10 can register a `tour-list` module with property presence and render `<TourList model={model} />`. S9 wires the ports. These integrations are pending their owners.

TLC reached 11 states and 53 steps with NoRetiredPrivate, UncertainKeepsRequest and NoDeadlock holding. Reproduce with the installed statechart script, `test/models/portal-tour-list/TourList.tla`, its sibling config and a fresh output directory. The readable chart above omits global retirement edges and self-transitions. Tests explicitly retire every live state through both expiry and disposal.

## Sources and proof

The synthetic package is unchanged from DoctorCRE/carr-system `865fefee26fcbbe50a04c7515c5f3d3bc8913cd1`. The plan, schema and probes are pinned there. S10 interface was read from app PR 665; app main before editing was `28a1a144cc6659b83617a19f06f504332570fe38`. Assigned rows are V-S24, V-T23..V-T28, V-A09, A-S26 and A-T32..A-T39. Private-reference parity, endpoint configuration and legacy redirects remain unproven or owned by S9. Existing URLs, passwords and roadmap are untouched.

Production proof is coordinator-owned. Read the deployed list and version, match property IDs, confirm logout denies the previous session, then observe a natural approved save and partner proposal readback. Do not submit a synthetic client choice.

## Design and debt pass

Codebase-design concentrates request identity and races behind one controller. Zero-tech-debt keeps routing and transport with their existing owners and adds no compatibility mode. No comments are needed in the new implementation.
