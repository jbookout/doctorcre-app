# Deals

Local Deals lets a partner review the Board or List, open one deal room and return to the same deal without changing its records.

## Sub-features

- `deals-board-open` opens the selected card's room.
- `deals-views` switches List and Board without changing records.
- `deals-list-open` opens the selected List row's room.
- `deals-deep-link` opens a room from its URL.
- `deals-home-open` opens the exact deal selected on Home.
- `deals-reopen` closes and reopens the same room.

## How to get to it (user POV)

- Choose `Local Deals` in `Primary navigation`, or open `/deals` directly.
- Choose `Board` and a deal heading, or choose `List` and a deal heading.
- Open `/deals?deal=d14` in local fixtures. On staging, use the selected synthetic deal's actual URL, not the fixture ID.
- Choose a deal alert on Home. The URL identifies that deal.

## Driving it with Playwright

Preconditions:

- Doctor passes and `.card-open` has at least one visible deal. The local seed includes `d14`, `Demo Surgical Practice`.

- **Board entry.** Run `await page.goto(new URL('/deals', origin).href)` and `await expect(page.locator('.card-open').first()).toBeVisible()`. Choose it with `await page.locator('.card-open').first().click()`. Require visible `#recordPanel`, a `#panelTitle` matching the chosen heading and visible `#detailUpdateForm`. The skill's complete smoke recipe performs this comparison.
- **Close and reopen.** Run `await page.getByRole('button', { name: 'Close deal', exact: true }).click()` and require `#recordPanel` hidden. Click that same heading and require the same title again. Capture the Board and open room.
- **List entry.** Close the room, then run `await page.getByRole('button', { name: 'List', exact: true }).click()`. Require `#listView` with `aria-pressed="true"`. Capture the chosen visible `.card-open` title, click it and require matching `#panelTitle`. Close the room, choose `Board`, and require `#boardView` pressed.
- **Direct entry.** Locally run `await page.goto(new URL('/deals?deal=d14', origin).href)`. Require `#panelTitle` containing `Demo Surgical Practice` and visible `#detailUpdateForm`. On staging, capture an existing synthetic room URL first and reopen that exact URL.
- **Home entry.** Run `await page.goto(new URL('/', origin).href)`. Read the first `#dealFlags a` href, click it, require that exact URL and the matching room title. This is a separate proof from Board opening.
- **Navigation entry.** From Home, click `page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Local Deals', exact: true })`. Require `/deals` and a usable Board.

## Gotchas

- Staging IDs are not fixture IDs. An empty staging Board fails the open-room precondition.
- Do not submit `Update`, change Phase or Owner, Park, or Mark inactive during this read-only journey.
- Use `.card-open` for the heading, not a whole card that also contains other controls.
- Deep-link close changes the URL. Assert the room state and URL independently.
