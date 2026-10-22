# Deal alerts

A deal alert should show a short deal heading and numbered items still needed. Selecting one item should open its own concise detail sheet.

## Sub-features

- `alerts-home-card` reads the Home alert card and its deal link.
- `alerts-deal-card` reads the same deal's Board card.
- `alerts-item-detail` opens one numbered item, checks its facts and closes it.

## How to get to it (user POV)

- Open Home and inspect the deal-attention cards.
- Choose the alert's deal heading to open that deal room.
- Open Local Deals and find that deal's card.
- Choose one numbered item title on the alert card to open the item detail.

## Driving it with Playwright

Preconditions:

- Doctor passes and the fixture or authorized staging deal has at least one open, structured alert item.
- Check this precondition before claiming item coverage. The seed at this skill's initial source has legacy `next_step` prose and no item sheet.

- **Home card.** Run `await page.goto(new URL('/', origin).href)` and `await expect(page.locator('#dealFlags .home-flag').first()).toBeVisible()`. Capture its ARIA snapshot and screenshot. Require only the short heading, `Still needed:`, numbered short item titles and due styling. Extra next-step prose fails the card requirement.
- **Deal entry.** Read and click the alert's `#dealFlags a` link. Require its exact `/deals?deal=...` destination and matching room title. This proves the deal link, not item opening.
- **Board card.** Open `/deals`, find that same heading among `.card-open` elements and inspect its surrounding `.kanban-card`. Require the same numbered item titles.
- **Item entry.** Within the alert card, run `await expect(card.getByRole('list')).toBeVisible()`, select the first item's button by its rendered title and click it. Require a visible dialog with that exact title, due date, dated fact bullets, `What was promised`, `From the call`, `Suggested next steps`, `Status` and a `Tell Dr. CRE` input. Capture the action and resulting dialog. Press Escape, require that dialog hidden and focus returned to its entry control. Here `card` is the selected alert locator, not an injected record.

## Gotchas

- **Known missing precondition.** At the initial source, Home uses `#dealFlags .home-flag`, but deal details render `.deal-current-action` as a paragraph and there is no numbered item sheet. `alerts-item-detail` must fail with that reason until the checklist feature and seed items arrive. Do not replace it with a whole-deal room, invent item data in the browser or report the legacy paragraph as a pass.
- Do not send `Tell Dr. CRE` or mark an item done during read-only verification. A write needs synthetic staging data, its normal verb and a separate readback.
- Missing required item sections fail the journey. Do not make assertions conditional on whether sections happen to exist.
