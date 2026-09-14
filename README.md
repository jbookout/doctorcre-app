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

```bash
npm test
npm run check
npm run build
npm run artifact:verify
npm run serve
npm run dev:staging
```

`npm run release:staging` accepts only a clean checkout whose `HEAD` exactly
matches `origin/main`, builds with that commit identity, creates the staging
Worker on first use, and otherwise uploads and promotes an immutable version.
`npm run rollback:staging -- <version-id>` restores one explicit earlier staging
version.

`npm run build` produces a deterministic `dist/doctorcre-app.tar`, its complete
file-and-contract manifest, a SHA-256 sidecar, and the exact `dist/site` static
deployment directory. Tagged `app-v*` releases run
the same checks and publish those three files. Consumers pin the exact source
commit and archive digest; they never import this repository's source tree.

The pinned consumer contract is `contracts/carr-interface.v1.json`. The live and
fixture adapters satisfy the same `DealRoomClient` interface in `js/client.js`.

The repository is publicly visible. No open-source license has been selected;
public visibility alone does not grant reuse rights.
