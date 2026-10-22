# Calendar

Calendar lets a partner move between periods, switch Week and Month and open a day's agenda without changing appointments.

## Sub-features

- `calendar-period` moves forward and back.
- `calendar-view` switches Week and Month.
- `calendar-day` opens a grid day.
- `calendar-agenda` opens a populated agenda entry.
- `calendar-today` returns to today.

## How to get to it (user POV)

- Open `/calendar` or follow the Calendar navigation link.
- Choose next or previous period, Week, Month, a day, an agenda entry, or Today.

## Driving it with Playwright

Preconditions:

- Doctor passes and `.cal-day-open` is visible. Agenda opening additionally needs at least one `.cal-agenda-item`; report missing entries as a failed precondition.

- **Entry.** Run `await page.goto(new URL('/calendar', origin).href)` and require `page.locator('.cal-day-open').first()` visible. Also follow the `Calendar` link when navigation changed; open the navigation's More menu first if the link is collapsed.
- **Periods.** Save `await page.locator('#calPeriod').innerText()`. Run `await page.locator('#calNext').click()` and require a different period. Run `await page.locator('#calPrev').click()` and require the original period.
- **Views.** Run `await page.getByRole('button', { name: 'Week', exact: true }).click()` and require `#calGrid` with `data-view="week"`. Click `Month` and require `data-view="month"`.
- **Day.** Run `await page.locator('.cal-day-open').first().click()` and require `#dayPanelTitle` different from `Choose a day`. Capture the selected day and panel together.
- **Agenda.** Run `await page.locator('.cal-agenda-item').first().click()` and require `page.locator('#dayPanelBody .cal-day-entry').first()` visible. Capture the selected entry and resulting facts.
- **Today.** Run `await page.locator('#calToday').click()` and require `[data-today="true"]` visible.

## Gotchas

- The current period changes with time and timezone. Save and compare the rendered value instead of hard-coding a month.
- An empty agenda still permits period navigation. Report `calendar-agenda` as unverified when no populated entry exists.
- Do not create, move or cancel an appointment during this read-only recipe.
