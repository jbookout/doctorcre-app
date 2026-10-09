# DoctorCRE

DoctorCRE is the independently built human application for CARR. CARR remains
the authority for business records, domain behavior, control, and assurance.

The application reads and changes real business data only through authenticated,
versioned CARR HTTP and MCP interfaces. It never connects to the CARR database.
`data/board-seed.json` is a visibly fictional fixture for local development and
tests; it cannot become production state.

The product remains a no-framework static application. Its small edge Worker
serves the immutable static build and forwards only reviewed authenticated CARR
routes through a private Cloudflare service binding.

Local development and the e2e runner require Node.js 22.22.3 or newer on Node 22, or 24.8.0 or newer.

```bash
npm ci
npx playwright install chromium
npm test
npm run check
npm run build
npm run artifact:verify
npm run serve
npm run dev:staging
```

`npm run privacy:check` requires the private name-hash corpus in
`~/.config/doctorcre-app/private-name-hashes.json`, or an explicit
`DOCTORCRE_PRIVACY_CORPUS_FILE` path. CI reads the
`DOCTORCRE_PRIVACY_CORPUS_JSON` Actions secret. Keep this record-derived lookup
material outside the public repository. Missing or malformed input fails the check.

### End-to-end journeys

The [e2e](https://www.npmjs.com/package/e2e) runner starts the fixture server
itself and drives Chromium through the merged V1 journeys on synthetic data.
Telemetry is off in `e2e.config.ts`.

```bash
npx e2e run tests/journeys   # deterministic, no model; the CI e2e job runs this
npx e2e run tests/agent      # agent.act/agent.assert variants, local only
```

The staging control sweep publishes a durable frontier after each measured
control and again after discovering its children. `npm run
e2e:staging:sweep:resume` keeps measured rows immutable, validates saved opener
actions against those rows, and replays their opening paths on fresh normal
staging sessions before testing only the remaining controls. Replaying an opener
restores UI state; staging mutations persist. A pending post-click discovery is
replayed before continuing, so a crash cannot silently omit its children.
Known remaining controls and opener depth are checkpointed; newly discovered
states can increase the remaining count. DOM identities are hashed before
publication so URL and credential redaction cannot change their bindings. Resume
matches that complete state digest and uses the unique live control for its
selector and option value; scrubbed metadata is never an action argument.
Existing unsullied legacy identity bindings retain their exact keys and measured
rows. A legacy identity already changed by redaction is refused rather than
reconstructed. Source pair changes and changed opener
identities fail rather than pretending to continue.

An incomplete legacy checkpoint without a frontier requires a conservative
screen retry from root. Its measured rows and findings remain in attempt history;
uncheckpointed traces and screenshots require separate review and do not count
as completed control results. Preserve and hash those artifacts before replacing
a legacy process. Neither sweep version exports in-memory results on SIGTERM.
Transient session transport and HTTP 429/502/503/504 failures receive at most
three requests; authentication refusals and release identity failures do not.
Provider error payloads and credentials are never forwarded to report errors.

The agent suite uses Joe's ChatGPT subscription, never an API key. Sign in once
per machine with `npx e2e login openai` (add `--device` to use a code instead of
a browser); `E2E_AGENT_MODEL` overrides the model id, and `npx e2e models openai`
lists the ids the login serves. CI configures no model and never runs it.

`npm run release:prepare` runs checks, tests, build and source-bound artifact
verification with a credential-free child environment. Run it before either
publication command. The CARR pipeline invokes this entrypoint separately from
the provider step.

`npm run release:staging` accepts only a clean checkout whose `HEAD` exactly
matches `origin/main`, verifies the prepared artifact, creates the staging
Worker on first use, and otherwise uploads and promotes an immutable version.
`npm run rollback:staging -- <version-id>` restores one explicit earlier staging
version.

The production Worker configuration deliberately has no route. It binds only to
the production `carr-mcp` service and enables version preview URLs, so a release
can be built, uploaded, and verified before any public hostname moves. Run
`npm run deployment:check:production` to validate that configuration locally.
`npm run release:production` consumes the prepared artifact, replaces `dist/site`
from its verified source bytes, and runs only provider upload, promotion and
readback commands. It refuses a missing `CLOUDFLARE_API_TOKEN`. Run publication from a clean
checkout at exactly `origin/main`
under the authorized release workflow. It uploads and promotes an
immutable production version through the same checks as staging; it never
creates a Worker on first use. `npm run rollback:production -- <version-id>`
restores one explicit earlier production version. Attaching `app.doctorcre.com`
or moving the hostname stays outside these scripts and outside `wrangler.jsonc`.

`npm run build` produces a deterministic `dist/doctorcre-app.tar`, its complete
file-and-contract manifest, a SHA-256 sidecar, and the exact `dist/site` static
deployment directory. Tagged `app-v*` releases run
the same checks and publish those three files. Consumers pin the exact source
commit and archive digest; they never import this repository's source tree.

The pinned consumer contract is `contracts/carr-interface.v1.json`. The live and
fixture adapters satisfy the same `DealRoomClient` interface in `js/client.js`.

The repository is publicly visible. No open-source license has been selected;
public visibility alone does not grant reuse rights.
