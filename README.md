# DoctorCRE

DoctorCRE is the independently built human application for CARR. CARR remains
the authority for business records, domain behavior, control, and assurance.

The application reads and changes real business data only through authenticated,
versioned CARR HTTP and MCP interfaces. It never connects to the CARR database.
`data/board-seed.json` is a visibly fictional fixture for local development and
tests; it cannot become production state.

The current implementation is deliberately a no-build static application.

```bash
npm test
npm run check
npm run serve
```

The pinned consumer contract is `contracts/carr-interface.v1.json`. The live and
fixture adapters satisfy the same `DealRoomClient` interface in `js/client.js`.

The repository is publicly visible. No open-source license has been selected;
public visibility alone does not grant reuse rights.
