# DoctorCRE static application

DoctorCRE is the human application for CARR. This repository owns the browser
product; CARR owns authoritative business records, domain behavior,
authentication, control, and assurance.

## Current transition state

- P1 isolates sanitized source. It does not move production hosting or change
  the CARR runtime.
- Production DoctorCRE continues to use the CARR-hosted application until a
  later phase proves an independent build and deployment boundary.
- The app communicates with CARR through the pinned contract in
  `contracts/carr-interface.v1.json`; it never connects to CARR's database.
- `data/board-seed.json` contains 11 explicitly synthetic records for local
  development and automated tests. It is not a production data source.

## Run locally

```bash
npm run check
npm test
npm run serve
```

Then open `http://127.0.0.1:8787/`. Local and unknown hosts use the synthetic
fixture. Reviewed DoctorCRE production hosts boot the live adapter.

## Product layout

| Path | Responsibility |
|------|----------------|
| `*.html` | DoctorCRE application surfaces |
| `work-inventory.html` | V5-UX-C10 Complete Work Inventory at `/work-inventory`: every work record from all six canonical CARR sources, in every status, with each source's coverage stated |
| `js/work-inventory-model.js` | Pure census rules: exact-key validation, grouping, coverage summary, query building, page merge |
| `js/work-inventory.js` | Work Inventory DOM wiring over `GET /api/v1/work-inventory` |
| `css/` | Product presentation and responsive behavior; `css/system.css` is the shared visual system bound to `contracts/visual-system.v1.json` |
| `js/client.js` | Small client interface selected by the app |
| `js/live-client.js` | Authenticated same-origin CARR adapter |
| `js/fixture-client.js` | In-memory synthetic adapter |
| `contracts/` | Pinned CARR consumer boundary, app routes and the visual-system contract |
| `data/board-seed.json` | Synthetic local/test fixture only |
| `reports/` and `tours/` | DoctorCRE report and tour presentation |
| `design*.html` | V5-UX-S01 review prototypes on synthetic data: `/design`, `/design/business`, `/design/operations` |
| `test/` | Product, interface, accessibility, and concurrency tests |

The application deliberately has no build step and no package dependencies.
That remains the default until a product requirement justifies more machinery.

## Boundary invariants

- Real deal data is read and changed through authenticated CARR interfaces.
- The browser never receives database credentials or chooses its own authority.
- Retries preserve idempotency keys and reconcile uncertain writes with CARR.
- No CARR server implementation is imported into this repository.
- No software-factory component is a runtime dependency.
