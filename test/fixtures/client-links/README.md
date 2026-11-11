# Client link response recordings

`producer.json` records synthetic inputs and outputs of the CARR production
`projectTourClientPacket` and `projectTourClientFeedback` functions. Its
`source_commit` identifies the feedback and exchange source revision.
`packet_source_commit` identifies the presentation 2.0.0 producer already pinned
in `../tour-packet/producer.json`. Packet recordings execute that exact template
through `test/packet-presentation.fixture.ts`, as PR 829's own packet fixtures do. Exchange acknowledgements and refusals
are recorded through `createReportsWebHandler` with its real exchange parser and
synthetic database rows. These in-memory calls do not contact a production service. Packet fixtures include the
required sequence and address. The near miss changes the real address field,
which survives production projection. Feedback scopes contain only the
producer's comment/shortlist permissions. Download visibility uses the separate
producer `can_download` capability.

Run the contract check with `CARR_CLIENT_LINKS_PRODUCER_CHECKOUT` pointing to
a clean checkout of that exact source revision:

```
node --test --test-name-pattern="response recordings" test/client-links-producer.test.ts
```

The browser suite builds the current artifact, including its authored download module and report styles.
It does not require generated `js/ui-tour-client-download.js` or git history.
These recordings prove the consumer wire shape, not production authorization.

Set `RECORD_CLIENT_LINKS_CONTRACT=1` with the producer checkout variable to
regenerate feedback responses. The checkout must match `source_commit`.
The feedback pin is CARR PR 3181 head `a90886e741f8d8d390c2427080da08e904ece7d8`.

The feedback unit tests replay complete HTTP envelopes for feedback permissions,
download permission, read-only access, saved feedback and absent download scope.
Expired and revoked cases record the producer response when its SQL authorization
returns no live feedback row. Both are coarse 503 share_unavailable responses.
The existing producer PostgreSQL matrix proves why those rows are absent; these
consumer recordings prove parsing and retirement only. No response capability is
patched by a fixture. The built reports/share.js executes its normal JSON parser,
HTTP status checks, feedback contract and capability check for every replay.

Regenerate only the packet and near-miss recordings with the existing pinned
producer helper, preserving their original stop inputs and all grant responses:

```
RECORD_CLIENT_LINKS_CONTRACT=1 node --test --test-name-pattern="pinned presentation" test/client-links-producer.test.ts
```

The unconditional packet test compares both recordings to the pinned producer
and parses them with the production packet parser. The shared packet contract
test verifies the template source digest. No CARR checkout or database is needed
for this packet-only refresh.
