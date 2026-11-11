# Client link proof inputs

`scripts/prove-client-links.ts` accepts `--commit`, `--origin`, `--evidence-file` and `--timeout-ms` (1 to 120000, default 30000).
The origin defaults to `https://app.doctorcre.com`. The expected commit is the full app merge SHA.
Git must contain that commit and the observed release commit to prove descendant ancestry.

The private evidence JSON has `active`, `revoked`, `viewOnly`, `pdfSha256` and `rows`.
The first three fields are distinct existing client URLs for the same projection.
Their origin is either the app origin or `https://reports.doctorcre.com`.
Each URL has the `/share` path and its original 43-character token fragment, either `#<token>` or the app-generated `#token=<token>`. Aliases normalize before checking that the three grants differ.
The active grant includes view and download. Verified feedback must expose the producer capability `can_download: true` for that grant. The client hides Download PDF until that capability is confirmed, and retires it when the session becomes unavailable. The view-only grant excludes download. The revoked grant was revoked before the proof.
The proof exchanges these existing links. It never creates, replaces or revokes grants.

`rows` is the ordered independent expected display readback, with one object per property.
Each object contains `propertyRef`, `label`, `name` and `detail`, all strings.
Copy those exact displayed fields from the reviewed public projection, not from the page being tested.
The proof observes each loaded packet response. It checks the packet stop count
against `rows`, checks that a supplied presentation summary names that count,
and compares the displayed summary exactly with the packet summary. Both the
app and proof use the production parser. Packets without presentation metadata
are the recorded 1.x format and are explicitly refused with an older-format
message. CARR 3182 regenerates presentation 2.0.0 on every read, including
existing grants. Deploy CARR 3182 before this app change. Presentation 2.0.0
supplies "in tour order.". Expected row labels remain
exact displayed text, including "Stop A" for presentation 2.0.0.
`pdfSha256` is the lowercase SHA-256 of the reviewed PDF for that projection.
Keep this file outside Git and logs. The proof output excludes links, cookies, rows and assertion values.

Exit 0 means all grants passed at 1440 and 390 widths in light and dark with a stable containing app release.
Exit 1 means a displayed value, permission, or supported packet format assertion failed on a containing release.
Exit 78 means the release, browser, network or independent input evidence was insufficient.
Recorded 1.x packets and downloaded PDFs with a pre-2.0.0 Tour template or CARR renderer are insufficient evidence. The refusal names the observed version.
The PDF digest check also requires embedded CARR renderer metadata. Stored, previously reviewed PDFs retain their original bytes; a current JSON packet does not upgrade them.
The proof refuses older, unrelated and unavailable release identities.
The app release identity does not attest the independent CARR deployment. Deploy CARR PRs 3181 and 3182 before running this proof for acceptance.

The proof statechart is [proof.mmd](statecharts/client-grants/proof.mmd).
Its model abstracts network and browser acquisition into one step. Executable tests cover late launch and stalled evaluation separately.
`test/client-links-proof.browser.ts` runs the real report renderer in the browser-test phase.
Its packet and near-miss address fixtures use the pinned presentation producer. Feedback fixtures are recorded through the CARR production projectors.
`test/client-links-proof.test.ts` checks parsing and release ancestry without a browser.
Those responses demonstrate proof behavior and do not establish production grant authorization.
