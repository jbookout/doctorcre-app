# Client link lifecycle

`grant-lifecycle.mmd` describes an existing grant and its client sessions. Rotation terminates the old grant. Its successor is a new grant with the same lifecycle.

The model checked in scratch with the statechart skill has six reachable states and eight transitions. All three access invariants hold. This models the required behavior; it does not replace executing the database authorization functions. Scanner previews leave the closed client session closed. Every open operation requires an available grant.

Regenerate in a scratch directory with the statechart skill's `statechart.mjs from-chart grant-lifecycle.mmd --png`, with TLC and Java configured. The guarded opens are necessary; omitting those guards exposes an open after expiry, revocation or rotation.

The app tests in `test/tour-client-grants.test.ts` cover hash-only issuance, rotation binding, invalid permissions, future expiry and status rendering. `test/dot-review.test.mjs` covers ambiguous issue and rotation retries with the exact retained request, malformed receipts, projection changes and session retirement. Existing CARR tests cover the browser routing and digest-only adapter. The database expiry and revoked-session rejection still require an integration run before this slice meets criterion 8.

The versioned CARR feedback contract exposes `can_download`, derived from live session scopes. The UI advertises Download PDF only when that capability is true. Independent signed-in taste review and a containing production release proof remain required.
