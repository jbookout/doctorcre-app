# Calendar

Calendar lets a partner change periods, switch Week and Month and open a day's critical dates.

## Sub-features

`calendar-period`, `calendar-view`, `calendar-day`, `calendar-agenda`, `calendar-today`.

## How to get to it (user POV)

Open `/calendar` or choose Calendar in navigation (under More when collapsed). Use previous/next period, Week, Month, a day, an agenda entry or Today.

## Driving it with Playwright

Existing coverage: `test/calendar.test.mjs` checks date, URL and view rules; `test/calendar-loading-browser.test.mjs` opens populated date details while another read is pending and checks session expiry. Both run in the Node suite. The staging period/agenda specs require separate authenticated staging verification.

- Require `.cal-day-open`, save `#calPeriod`, click `#calNext`, require a different period, then `#calPrev` and require the original.
- Choose Week then Month; require `#calGrid[data-view="week"]` then `data-view="month"`.
- Choose a `.cal-day-open`; require `#dayPanelTitle` changed from Choose a day. Choose a populated `.cal-agenda-item`; require its date's `#dayPanelBody .cal-day-entry` and selected facts.
- Choose `#calToday`; require `[data-today="true"]` visible.

## Gotchas

Periods and agenda availability depend on date and timezone. Compare rendered values; do not hard-code the current month. An empty agenda cannot prove entry opening. Never create, move or cancel an appointment in this read-only inspection.
