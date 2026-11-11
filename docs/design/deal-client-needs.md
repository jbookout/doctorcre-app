# Deal-owned client need authoring

The deal workspace mounts one typed panel. CARR owns need identity, source revision, content revision, approval and matching. The panel never derives a need from checklist prose. It calls the four deployed client-needs.v1 verbs through the existing cookie-authenticated MCP transport.

The producer contract is copied unchanged from DoctorCRE/carr-system main at 4b6533b2ce155b0622546e2a10fe48038bdbdcee. PR 3188 introduced it. PR 843 supplies the consumer convention of validating the pinned JSON schema and then validating query identity and freshness. This panel accepts every deal-owned lifecycle state. Vendor results must be approved, current, unrestricted and bound to the exact vendor.

Two interfaces were considered. Adding forms and command state to pipeline.js would reuse its existing command dispatcher but spread need revisions across the workspace renderer. A mounted panel with a single controller keeps the review snapshot, pending operation and response validation together. The latter is used. Pipeline owns only mounting and the existing MCP transport.

## System design

The controller owns the current page and a discriminated screen state. The React panel owns presentation. One module-local controller per deal and client survives panel remounts and retains unknown write keys. Session invalidation retires every controller, clears records and ignores late responses. No business data is stored in browser storage.

Each read requests at most 50 rows, advances a validated offset and loads another page only when requested. There is no polling, fan-out, queue or background retry. At current load and ten times that load, server pagination bounds each request. Very long deal histories increase retained page memory first. CARR handles storage access and vendor joins, so the app makes no per-row reads.

The circuit breaker is one in-flight operation. Its transport has a ten-second deadline. Any unconfirmed write stops further writes and shows the retained request key. Only an explicit check sends that same operation again. A business refusal requires a fresh read and review. New write intents mint a new key. No stale snapshot can be approved silently. Approval sends the displayed record version, while CARR checks it transactionally. An edit never submits approval.

Reads are live and fail closed. A read error clears the list and exposes reload. Approval availability checks restrictions and freshness again when clicked. The producer remains authoritative when time passes or another writer changes the need. No sends or introductions belong to this workflow.

## Statechart coverage

The chart is deal-client-needs.mmd. The executable model leaves server transactions and wall-clock progression to CARR. Its independent regions describe need lifecycle, panel state and session authority. Tests use the public controller and mounted panel.

| Transition | Test |
| --- | --- |
| Draft or edited need to approved; review and cancel | review cancel never writes; approval sends displayed version; edit lapses approval |
| Approved to edited-lapsed; save refreshed or restored evidence | author list, create, edit, exact review, cancel and withdraw at four sizes |
| Draft, approved, lapsed or stale to withdrawn | unknown retains one request key, fences new writes, and checks only on request; mounted authoring test |
| Approved to stale; all ineligible needs absent from matches | vendor read excludes drafts, lapsed, withdrawn, restricted and stale needs |
| List to edit, edit to pending, confirmation to list, pagination, unavailable read recovery | new need creates once, pagination advances, unavailable reads reload and no write overlaps pending |
| Pending to unknown to explicit same-key check | unknown retains one request key, fences new writes, and checks only on request |
| Pending to conflict, reload current, retirement from any screen | conflict requires reload and retired panels ignore late responses; mounted authoring test |

## Production proof

Run scripts/prove-deal-client-needs.ts with the expected app merge commit, expected producer merge commit, producer repository, an existing deal, its client, exact vendor and a signed-in CDP endpoint. The command admits containing releases, compares the approved need field for field across deal and vendor reads, proves an existing lapsed or withdrawn need absent, then opens and cancels a local revision review at both widths and themes. It never submits an approval. Exit 0 means the read-only assertions passed. Exit 1 means a containing release failed an assertion. Exit 78 means evidence is insufficient, including no qualifying recorded needs or no signed-in session.
