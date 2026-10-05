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

Local development and the e2e runner require Node.js 22.12.0 or newer.

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

### Agent verification

[verify-doctorcre](.cursor/skills/verify-doctorcre/SKILL.md) launches an isolated
local fixture server and drives the app with Playwright. Its
[feature map](.cursor/skills/verify-doctorcre/features/README.md) defines the
covered user paths; screenshots, ARIA snapshots, traces, and byte manifests
survive cleanup.

### End-to-end journeys

The [e2e](https://www.npmjs.com/package/e2e) runner starts the fixture server
itself and drives Chromium through the merged V1 journeys on synthetic data.
Telemetry is off in `e2e.config.ts`.

```bash
npx e2e run tests/journeys   # deterministic, no model; the CI e2e job runs this
npx e2e run tests/agent      # agent.act/agent.assert variants, local only
```

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
