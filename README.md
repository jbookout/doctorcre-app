# DoctorCRE

DoctorCRE is the independently built human application for CARR. CARR remains
the authority for business records, domain behavior, control, and assurance.

The application reads and changes real business data only through authenticated,
versioned CARR HTTP and MCP interfaces. It never connects to the CARR database.
`data/board-seed.json` is a visibly fictional fixture for local development and
tests; it cannot become production state.

The product remains a no-framework static application. Its small edge Worker
serves the immutable static build and forwards only reviewed authenticated CARR
routes through a private Cloudflare service binding. Browser and edge failures
are scrubbed, deduplicated and rate-limited in the app before they reach CARR's
runtime-error ingress (`contracts/runtime-errors.v1.json`, `CARR_ERRORS`).

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
(`npm run serve`) and runs `tests/journeys` on a desktop and a phone viewport.
The QA regressions use their own fixture server and config.

```bash
npm run build
npx e2e run
npm run test:regressions
```

The signed-in staging smoke uses [Playwright Test](https://playwright.dev/docs/intro)
and its [authentication setup project](https://playwright.dev/docs/auth).
Provide `E2E_SESSION_SECRET` through the environment, then run:

```bash
npx playwright test --project=chromium
```

The setup exchanges that secret at staging's `/auth/e2e-session` for the
synthetic `e2e-joe` account and saves `storageState` under ignored
`playwright/.auth/`. The Chromium journey visits Home, Leads, Tours, Local Deals,
Vendors, Control Room, Relationships and Invoices, then reloads Home and checks
the account menu. It uses the fixed staging origin in `playwright.config.ts`.
Keep the secret and saved browser state out of logs and commits. The existing
fixture suites continue to run separately.

`npx playwright test --project=fixtures` runs migrated, credential-free browser
tests with Playwright's page and context fixtures. Known staging failures stay
as individual `test.fixme` cases tagged `@fixme`; list them with
`npx playwright test --project=chromium --list --grep @fixme`.

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

Every PR runs `npm run performance:check` after the build in the required CI
`test` job. It measures Home, Local Deals, Vendors, Tours, Relationships, and
Invoices from `dist/site`, with synthetic records and cold Chromium contexts:
390×844 mobile viewport, 4× CPU slowdown, 150 ms latency, 1.6 Mbps download.
Three runs produce median LCP and scripted interaction latency; screen JS is
the largest unique script-byte total loaded through that interaction. Total
shipped JS includes every `.js`/`.mjs` in the static artifact; gzip is reported
as the sum of per-file compressed sizes.

`contracts/performance-budget.v1.json` records the measured baseline, source
commit, build digest, and headroom. A breach fails with screen, metric, before,
after, and budget. PR authors reduce the failing metric and rerun the check;
budget increases require visible review in the budget diff. To re-measure the
baseline, save a hosted `test` job log (it holds one `performance-report <base64url>` line) and run
`node scripts/performance-budget.mjs --rebaseline contracts/performance-budget.v1.json <file>`;
it applies the one headroom rule, which a test holds every committed limit to. This is a lab
regression guard: interaction latency runs from the browser pointer timestamp
to the verified UI change plus two animation frames, and is not field INP.
The baseline preserves existing slow screens; it does not certify speed.

CI keeps JSON, the performance summary, and Playwright failure traces as artifacts.
The CI job publishes the performance summary in its job summary.

`npm run docs:check` warns about broken local Markdown links and unknown documented npm commands.
