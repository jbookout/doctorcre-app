# Producer-checked CARR fixtures

`checkedCarrFixture('market-terms-empty')` returns the checked response unchanged. Feed it into the same production client or parser that the test already exercises. Browser tests can load it in Node and pass the returned object into `page.evaluate`; they must not rebuild a reduced response in the browser callback.

Store recordings in `test/fixtures/carr/<slug>.json`. Each contains `producer`, `source_sha256`, deterministic `input`, and `response`. `npm run check` replays every recording and rejects mismatches, including derived fields such as distinct deal counts. Unknown producers fail closed. The current replay adapters cover `read-market-terms` and the calendar section shared by the brief and meeting-prep producer.

The full upstream producer files live as inert text under `test/fixtures/carr-producers`. Pins name their exact repository revision, source path, SHA-256 and pure declarations. The helper executes those declarations with synthetic inputs. Updating a pin requires obtaining the source at the new revision and replaying all affected recordings. The tests never fetch a repository or read historical Git objects. This is test-only code; the app artifact does not import it.

The source check discovers response object literals in `test/`, `tests/` and `scripts/`, including nested callbacks, JS/TS and JSON. It recognizes envelope keys `ok`, `jsonrpc`, `schema_version`, and response keys `filings`, `sections`, `coverage`, and paired `state`/`items`. A helper import does not excuse a handwritten response. These signatures are conservative syntax checks, not whole-program data-flow analysis. Computed constructions, assignment mutations, and other response shapes still need review. Add a signature and its regression when introducing another response family.

Existing unchecked literals are migration debt in `carr-legacy-literals.json`. The value is the SHA-256 of the sorted literal-digest multiset per file. Changing surrounding test code does not expand the exception; adding or changing any response literal fails. Do not refresh the baseline to make a new fixture pass. Migrate the affected literals into producer replay records instead. Removing old literals also requires removing or narrowing that file's baseline entry.

Adversarial parser tests can clone a checked response and explicitly mutate the invalid field. Keep the valid recording and the deliberate mutation separate. Such mutations are negative test inputs, not producer-certified responses.

For a producer that cannot run as a pure projection and has no exported response validator, request the owning CARR contract export. Do not invent a consumer-side validator and call it the producer contract. In particular, the email-filings SQL projection needs that export before new filing fixtures can be certified here.
