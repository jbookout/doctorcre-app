# DoctorCRE verification map

Follow [Launch, Doctor and Drive](../SKILL.md) first. This map describes current controls and existing coverage; it does not claim every path has passed.

- Use a fresh browser context for each feature. Dismiss the morning brief if it covers a control.
- Use synthetic fixtures locally. Leads needs its existing HTTP fixture adapter; a plain preview is not a populated Leads backend.
- Prefer named controls. Select the visible Board or List entry rather than an arbitrary `.card-open` that may belong to a hidden view.
- Capture the entry, action and result. Record the selected record's title and URL before opening it, then compare the resulting detail.
- Report absent data, skipped tests and unvisited entry points. Local writes prove only synthetic behavior. Staging requires its own auth and release checks.
- Feature pages have four sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, and `Gotchas`.

## Features

- [Workspace](workspace.md): flagged desktop group zoom and phone restoration.
- [Home](home.md): scopes, refresh and deal entry.
- [Deals](deals.md): Board, List, room, direct links and closing.
- [Deal alerts](deal-alerts.md): current overdue flags and deal links.
- [Leads](leads.md): search, filters and details through the existing adapter.
- [Calendar](calendar.md): periods, views, selected days and agenda.
- [Vendors](vendors.md): recorded contacts, offices, and territory in the existing record dialog.
- [Client portal](client-portal.md): password entry, canonical roadmap, shared text and locking.
