# Home

Home shows current work and deal attention, with personal and team scopes and links to matching deal rooms.

## Sub-features

`home-scope`, `home-refresh`, `home-deal-open`, `brief-queues`.

## How to get to it (user POV)

Open `/` or choose Home in Primary navigation. Use Just me, Team view, Refresh Home, or a deal in the attention region.

## Driving it with Playwright

Existing coverage: `test/home-dashboard-browser.test.mjs`, `test/deal-attention-browser.test.mjs` and `test/home-deployed-contract.test.mjs`, all run by the skill's Node suite.

- Require the Home heading and a settled `#dealAttention[aria-busy="false"]`.
- Switch Just me and Team view; require the selected button's `aria-pressed="true"` and compare the rendered deal entries.
- Use Refresh Home; require settled attention and `#observedAt` without Unavailable or Sign in.
- Read a `#dealFlags a.home-flag` link's `href` and its `strong` title, then click. Require the exact destination, visible `#recordPanel`, and matching `#panelTitle`. Also check the Home navigation link when routing changes.

Morning brief queue coverage: `test/morning-brief-queue.test.mjs` and `test/morning-brief-queue-browser.test.mjs`. Open Morning brief, select a named queue, require the returned count, load more, and require the next row in server order. The queue view is independent of the priority owner filter. Needs Joe is Joe-only. Failed pages keep a visible retry and never imply completion.

## Gotchas

Counts depend on date and scope. Existing tests own their clock and synthetic records. No alerts is a valid Home state but cannot prove deal opening. A failed or partial read must remain visible as such; a shell alone is not readiness.
