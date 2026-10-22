# Home

Home shows the partner's current work and deal attention, with personal and team scopes and links to the matching deal rooms.

## Sub-features

- `home-scope` switches Just me and Team view.
- `home-refresh` reloads deal attention.
- `home-deal-open` opens the selected deal.

## How to get to it (user POV)

- Open `/`, or choose `Home` in `Primary navigation` from another page.
- Choose `Just me`, `Team view`, or `Refresh Home`.
- Choose a deal in the deal-attention region.

## Driving it with Playwright

Preconditions:

- Doctor passes. For opening an alert, at least one `#dealFlags a` exists.

- **Home entry.** Run `await page.goto(new URL('/', origin).href)`. Require `page.getByRole('heading', { name: 'Home', exact: true })` visible. From Deals, also click the `Home` link inside `Primary navigation` and require `/`.
- **Personal scope.** Run `await page.getByRole('button', { name: 'Just me', exact: true }).click()` and require that button's `aria-pressed` is `true`.
- **Team scope.** Run `await page.getByRole('button', { name: 'Team view', exact: true }).click()` and require its `aria-pressed` is `true`. Capture both scopes and compare their deal entries.
- **Refresh.** Run `await page.getByRole('button', { name: 'Refresh Home', exact: true }).click()`. Require `#dealAttention` with `aria-busy="false"` and `#observedAt` without `Unavailable` or `Sign in`.
- **Deal entry.** Save `await page.locator('#dealFlags a').first().getAttribute('href')`, click that link and require its exact destination, visible `#recordPanel` and nonempty `#panelTitle`. Capture before and after; compare the selected deal heading with the room title.

## Gotchas

- Alert counts depend on date and scope. Do not freeze app state with internal setters. If testing time-dependent fixtures, use the existing browser clock helper and record the chosen time.
- No alerts is a valid Home state but fails the alert-opening precondition. Report that path unverified rather than treating the empty screen as opening proof.
- The morning brief can cover navigation. Use the existing dismissal handler.
