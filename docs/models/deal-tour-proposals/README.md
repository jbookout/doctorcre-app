# Deal tour proposals

Card: WR586.S5.J5

System design written before implementation. CARR owns proposal identity, portal revision, cart version and resolution. The app owns transient comparison choices. One typed adapter parses the pinned CARR contract and exposes list, resolve and shortlist readback. The workspace mounts one comparison module and reports pending counts to deal and Tours badges. No portal call, pull command or second shortlist is introduced.

The lifecycle is in lifecycle.mmd. Choosing is local. Only choosing to accepting sends a resolution. A stale refusal retains choices and requires a fresh comparison before another accept. An uncertain outcome retains the exact request and idempotency key for replay. Acceptance is reported only after a receipt and existing cart readback. Dismissal leaves the cart alone. Route and appointment data are never written.

Capacity and load spread. At current and 10x load each open workspace makes one list read, bounded by CARR to 50 rows and 100 properties per proposal. Only the displayed proposal hydrates one tour for labels. No per-property requests or background polling. List size and property rendering break first at the producer limits. Readback adds one cart request. Requests are sequential only where they depend on proposal identity. No app queue or fan-out.

Caching and storage. Transient choices and retained request live only in the mounted workspace, are discarded on session invalidation or disposal, and are never persisted. No database access or cache eviction process. CARR continues using the existing Postgres cart. Unavailable labels are explicitly identified, never matched by address. No N+1 property lookup.

Availability and consistency. Unknown-tool hides the surface. Other read failures show unavailable, never an empty-list success. Writes refuse stale versions. An accepted receipt with failed readback remains unconfirmed and can reread without sending a new resolution. Every write carries an idempotency key. The contract binds portal revision to immutable proposal ID and accepts only the expected cart version, so no unsupported revision argument is sent.

Circuit breakers and limits. No automatic retry. A single in-flight operation per module and a two-failure, 60-second adapter breaker bound each external transport. Session transport supplies cancellation and a 10-second deadline. Read failures surface one fallback message. No external alert destination exists; the visible unavailable/refused state is the alert. User-triggered replay retains the exact payload. No periodic loop, remote portal request or production write.

Throughput checkpoint. Blocking first steps are contract study, statechart and failing acceptance test. Independent workstreams are n/a because one worker owns the coupled adapter and UI. Shared mutable state is isolated to the mount and fixture. Smallest safe decomposition is one worker because proposal and cart consistency are one invariant.

The chart is a design model, not a TLC proof. Tests execute UI transitions and transport effects against synthetic fixtures.

The mirrored proposal contract is pinned independently to CARR revision 65afcc1f2d9147314200c5111986dec43e668189. Its actual path is workspace/contracts/client-tour-proposals.v1.json. The brief's portal-tour-proposals path does not exist at that revision. The producer accepts immutable proposal ID plus shortlist version, rather than a separate portal-version argument. Existing global CARR contracts keep their prior pin.

Design and debt pass. The alternatives were adding proposal methods to both large DealRoomClient adapters, or putting a typed proposal module at the MCP seam. The latter keeps version parsing, retained resolution and readback together, without changing live-client.js or fixture-client.js. Codebase-design keeps one small mounted interface with injected live and fixture adapters. Zero-tech-debt keeps the existing selection cart authoritative, removes full-membership per-property writes in favor of only changed memberships, and introduces no compatibility path or second shortlist.

Experience First keeps stale choices visible and labels unavailable facts honestly. Model the Domain uses a discriminated lifecycle instead of independent booleans for comparison and decision states. Test Behavior, Not Implementation checks visible differences, shortlist membership and outgoing requests. The installed statechart fallback was /Users/booko/.codex/plugins/cache/cursor-plugins/pstack/0.15.36/skills/statechart/SKILL.md. TLC was not run. The first failing test was proposal_card_changes_nothing_until_accept, which failed before the proposal fixture and module were exported.

Production proof remains pending. After CARR S5 and this app branch deploy with verified release readbacks, a client saves a list on the portal. The signed-in deal workspace must show the correct differences and badge. CARR must remain unchanged before Accept. After Accept, the shortlist must read back the chosen IDs while route appointments remain unchanged. Joe's sign-in is the one human step. The missing portal selection endpoint remains a separate activation dependency.
