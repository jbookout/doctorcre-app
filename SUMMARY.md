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
| `tasks.html` | V5-UX-B02 Tasks at `/tasks`: the shared record of open task and team loops, with Quick add capture, handover, due dates and completion |
| `js/task-records-model.js` | Pure task rules: board-row validation, owner scoping, handover/close/due argument sets, the Quick add plan and the operation keys |
| `js/task-records.js` | Tasks DOM wiring over the loop verbs, through the shared command kernel and dock |
| `css/` | Product presentation and responsive behavior; `css/system.css` is the shared visual system bound to `contracts/visual-system.v1.json` |
| `js/doc-dock.js` | The one floating Doc icon and its chat window, shared by every surface |
| `js/client.js` | Small client interface selected by the app |
| `js/live-client.js` | Authenticated same-origin CARR adapter |
| `js/fixture-client.js` | In-memory synthetic adapter |
| `contracts/` | Pinned CARR consumer boundary, app routes and the visual-system contract |
| `data/board-seed.json` | Synthetic local/test fixture only |
| `reports/` and `tours/` | DoctorCRE report and tour presentation |
| `design*.html` | V5-UX-S01 review prototypes on synthetic data: `/design`, `/design/business`, `/design/operations` |

### V5-UX-S01 information design, after Joe's 2026-09-16 review

The register did not change: same dark cinematic ground, same glass, same
palette, same light theme. What changed is how information is arranged.

- Each prototype page is a tab strip (`role=tablist`), one screen per tab, with
  popups instead of a long scroll. A "go to" link switches tabs or opens a
  popup; a link to another surface opens in a new browser tab.
- Tiles list their actual items. Every row is a button that opens that item's
  popup, and an action item's popup carries a small form that answers it into
  the receipt dock.
- Doc is ONE floating round icon at the bottom right of every surface, clear of
  the mobile navigation. It opens a nonmodal chat that names the page it is
  reading, with a transcript, an input, Send, and a "Dictate with Quill"
  microphone that toggles a visible listening state. The replies are canned and
  marked "Prototype reply". There is no per-tile Ask Doc button.
- Cards move by mouse drag with the drop target highlighted. The keyboard
  equivalent is the same move on the focused card — Enter lifts, arrows choose,
  Enter drops, Escape cancels — announced through an aria-live region. The Move
  menu is retired.
- Theme, density and motion are one icon each: filled is on, hollow is off.
- Every clock time is 12-hour AM/PM. Every due date is a calendar date with an
  `<input type="date">` picker and a typed-date fallback.
- Motion runs about 1.5x slower and the spinner is gone: waiting is a circular
  stroke that draws and fades over `--motion-ring`. The reduced-motion floor is
  unchanged.
- Titles carry their screens. No description paragraph sits under a heading,
  and `test/visual-system.test.mjs` fails on the phrases the review refused, on
  a 24-hour clock, on a missing tab strip or floating Doc, on a Move button, and
  on a missing keyboard move path.
| `test/` | Product, interface, accessibility, and concurrency tests |

The application deliberately has no build step and no package dependencies.
That remains the default until a product requirement justifies more machinery.

## Boundary invariants

- Real deal data is read and changed through authenticated CARR interfaces.
- The browser never receives database credentials or chooses its own authority.
- Retries preserve idempotency keys and reconcile uncertain writes with CARR.
- No CARR server implementation is imported into this repository.
- No software-factory component is a runtime dependency.
