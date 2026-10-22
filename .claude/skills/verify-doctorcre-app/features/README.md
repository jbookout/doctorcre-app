# DoctorCRE verification map

Read this index before driving the app. These recipes are the maintained source for user-facing verification, not a record that every path has passed.

## Baseline preconditions

- Follow [Launch and Doctor](../SKILL.md) first. Use a run-owned local port and fresh browser storage, or the authenticated staging target in an isolated checkout.
- Local pages use the repository's synthetic fixture adapter. Do not select live mode locally or copy real client data into fixtures.
- In the recipe snippets, `page` is the existing Playwright page, `expect` comes from `@playwright/test`, and `origin` is the owned fixture server URL or the staging origin from the skill.
- Use an empty browser context for each feature. Dismiss the morning brief with the skill's locator handler.

## Driving conventions

- Use the real user entry points and exact selectors below. Start from the baseline unless a recipe states otherwise.
- Paste a recipe's actions into the Drive block in the skill. Keep its launch, doctor, evidence and cleanup, and update the report's feature ID and screenshot names.
- Capture the entry state, action and resulting state. Retain screenshots, ARIA snapshots, trace, result and cleanup evidence outside retiring checkouts.
- Check each listed entry point relevant to the change. A Board proof does not also verify a Home link or direct URL.
- Read-only navigation is the default. A mutation needs an authorized synthetic target, separate readback and cleanup.

## Proof and skip reporting

- Record feature IDs and entry points with the artifacts. Report failed assertions, missing preconditions and unvisited paths explicitly.
- A missing record, alert item or agenda entry is a failed journey precondition. Do not replace an assertion with a conditional pass.
- Local synthetic state does not prove staging auth, deployed revision or record-layer persistence. Use the exact staging gap list in the skill.
- Inspect the images. Preserve evidence when cleaning up, including evidence from failed iterations.

## Feature entry contract

Each feature has an H1 and one user-facing paragraph, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, and `Gotchas`.

## Features

- [Home](home.md) covers scope switches, refresh and entry to a deal.
- [Deals](deals.md) covers Board, List, room opening, deep links and closing.
- [Deal alerts](deal-alerts.md) covers the alert card and required item detail, including the current missing item precondition.
- [Leads](leads.md) covers search, filters and read-only details.
- [Calendar](calendar.md) covers periods, day selection and agenda entries.
