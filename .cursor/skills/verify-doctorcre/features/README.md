# DoctorCRE verification map

Read this index and the matching feature file before driving the app. Each feature file describes user paths, harness actions, and observable proof with poteto's four fixed sections.

## Baseline preconditions

- Install the repository dependencies and Chromium as described in [the skill](../SKILL.md).
- Launch only the CLI-owned loopback fixture server; require its `doctor` check to pass.
- Use fresh isolated browser contexts and repository synthetic fixtures.
- Never point the CLI at production or supply real partner records.

## Selection and scope

The first features follow the brokerage destinations in the primary shared navigation: Home, Leads, Tours, Local Deals, and Vendors. Their source entries are `js/slices/home.js`, `leads.js`, `tours.js`, `deals.js`, and `directory.js`. Existing deterministic journeys support the selection. The repo has no usage telemetry; this is a priority inference from navigation and task flows. Progress navigation adds the historical regression oracle.

This seed covers these workflows. Other routes, including Clients, Calendar, invoices, lease radar, relationships, Control Room operations, and Doc chat, need their own map entries and live recipes before a run may claim coverage of them.

## Driving conventions and proof

- Run `drive <feature-id>` or `drive all` through the executable helper.
- Each recipe exercises its listed entry points; one entry cannot stand for another.
- Preserve failed runs and their attempted actions. An unreachable entry records its unmet prerequisite and cannot be reported as passed.
- Capture before and after screens, ARIA snapshots, action/result records, traces, and requests.
- Read durable draft fields back after reload. Deal fixture mutations are session-only and cannot prove CARR persistence.
- Cleanup stops owned instances and retires scratch state; evidence survives.

## Feature index

```json
{
  "schema": "verify-feature-map.v1",
  "product": "doctorcre",
  "features": [
    {
      "id": "home",
      "file": "features/home.md"
    },
    {
      "id": "leads",
      "file": "features/leads.md"
    },
    {
      "id": "tours",
      "file": "features/tours.md"
    },
    {
      "id": "local-deals",
      "file": "features/local-deals.md"
    },
    {
      "id": "vendors",
      "file": "features/vendors.md"
    },
    {
      "id": "progress-navigation",
      "file": "features/progress-navigation.md"
    }
  ]
}
```

- [Home attention](./home.md)
- [Leads workspace](./leads.md)
- [Tour planning drafts](./tours.md)
- [Local Deals board](./local-deals.md)
- [Vendor directory](./vendors.md)
- [Progress board navigation](./progress-navigation.md)

The fenced JSON reuses software-factory's `verify-feature-map.v1` index and feature shapes, inspected at source revision `28e3f385734107560a9c0d882d3e3ed3c48ae07d` in `schemas/design-verify.schema.json` and `src/design-verify.mjs`. Poteto's Markdown sections govern the human-readable recipe. No runtime import or assurance fabric is copied from software-factory.

Run `/maintain-verification-skill` when app changes make this map drift; its source and live passes cover every listed feature.
