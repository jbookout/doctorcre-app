# Retained document text

The document list opens a keyed viewer for one deal, attachment and original hash. The viewer keeps a single parsed chunk. Closing, changing the document, refreshing the list or retiring the session removes that viewer. Complete-line metadata is the selection seam for Slice B. This change does not select, annotate or send.

## System design

The list owns the chosen document and filename. The viewer owns reading state and the current chunk. The pure parser owns validation of the pinned producer contract and continuity. The existing authenticated RPC owns sessions, cancellation and deadlines. A parent-owned accumulated text cache was considered. It would couple list refresh and pagination to retained sensitive text, so the keyed viewer is the chosen interface.

Capacity is at most 200 fragments and 16000 Unicode code points per viewer, below the producer's 500000-code-point and 1000-page document caps. At ten times the number of concurrent readers, producer read capacity is the first external limit. There is no per-line request, prefetch, persistent browser storage or app text cache.

Calls are sequential and user initiated. There is at most one request per viewer. The existing RPC deadline bounds a stalled read. A read failure opens the circuit immediately, clears displayed text and exposes explicit Retry. There is no automatic retry, alternate source, extraction or OCR. Closing or retiring aborts the request and changes its generation. Late results cannot commit state.

There are no queues, writes, send effects or idempotency keys. The only storage access is one registered retained-text read per chunk. The app never reads SQL, object keys or PDF bytes. The viewer refuses stale identity and derivative changes. Every navigation evicts the old chunk. Different pages returned together keep their original addresses.

## Contract and fixtures

The producer is DoctorCRE/carr-system at 5263b3ac5c07af957c1db0fce5542f54156ef06e. The exact response schema SHA256 is 169ad22a99c63b18670ded1fcbd0c2d6f6263f52f5fd54ebb88107292159b812. `contracts/deal-document-text.v1/provenance.json` pins the source and recordings.

The four producer-owned recordings come from its registered PostgreSQL lifecycle test. Additional recordings were executed through `executeRegisteredTool` with an injected synthetic retained row matching that test's pages. They are registered handler responses, not a copied paginator. All recordings pass the producer schema and the production parser. Negative tests deliberately mutate recordings. No test requires historical Git objects or a CARR checkout.

The browser parser does not compile code at runtime. This keeps the viewer compatible with the app's script CSP. Producer schema validation runs independently in tests.

## Statechart and transition coverage

`docs/statecharts/viewer.mmd` was compiled before implementation. Lifecycle and request identity are separate regions. `Viewer.tla` and `Viewer.cfg` retain that model. Regenerate by copying those three files to a scratch directory and running the statechart skill's `from-chart` command there with Java and TLA2TOOLS configured. The compiler writes its mapping and result files beside the scratch input.

`ViewerCode.tla` adds the actual lifecycle and current-request guards, with source anchors. Run the statechart skill with `from-spec docs/statecharts/ViewerCode.tla --map docs/statecharts/ViewerCode.map.ts` to check and draw the implementation model. The initial chart deliberately overapproximates region interleavings; the guarded model excludes impossible button actions. Both models check the two never rules.

The lifecycle model groups not-ready, unsupported and transport failure under Unavailable. It abstracts byte contents, DOM layout and concrete generation numbers. The parser and browser tests cover those details independently. The two never rules cover Ready with a pending/replaced identity and Expired with retained text.

| Action | Named test coverage in deal-document-text-browser.browser.ts |
| --- | --- |
| Open, Produced | Open Produced Navigate and Close preserve exact source addresses |
| Navigate, continuation | Page Navigate Unicode continuation keyboard and axe, all three widths and both themes |
| Failed, NoTextFound, Changed, Retry | Failed NoTextFound Changed Retry Close, each availability outcome and source change |
| Switch, Close, Retire | Retire/Switch/Close and Late from each lifecycle state |
| Late | Late result is ignored in loading/ready/unavailable/no_text/source_changed/closed/expired |
| NoCrossIdentity, NoPostExpiryText | Both named invariants in transition matrix, plus every late-result destination |
| Authorization retirement | Retire on authorization 401/403 refuses old text |
| Deal disposal | Dispose and deal switch abort pending read and refuse late text |

## Production proof A

After an app release contains the actual merge commit, an attended authenticated reader opens a known produced lease or LOI from its deal's document list. Independently call registered `read-deal-document-text` with exactly the same deal, attachment, original hash and requested position. Compare the filename and each displayed page, line, offset and text by equality. Preserve blank lines and a response split within a line. Check explicit continuation, page navigation, close and reopen at phone and desktop widths. Capture the release identity and both boundary-preserving observations. No send occurs. Concatenated text alone is insufficient. This worker uses synthetic data only and does not perform this post-deploy proof.
