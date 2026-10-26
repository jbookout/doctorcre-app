# Home

Home shows current work and deal attention, with personal and team scopes and links to matching deal rooms.

## Sub-features

`home-scope`, `home-refresh`, `home-deal-open`, `brief-queues`, and the shared Morning brief dialog.

## How to get to it (user POV)

Open `/` or choose Home in Primary navigation. Use Just me, Team view, Refresh Home, or a deal in the attention region.

## Driving it with Playwright

Existing coverage: `test/home-dashboard-browser.test.mjs`, `test/deal-attention-browser.test.mjs` and `test/home-deployed-contract.test.mjs`, all run by the skill's Node suite.

- Require no Control Room panel or radar in Home. System queues stay in Control Room, reachable from Primary navigation. Initial load and Refresh Home make no incident, work, request, resource or schedule reads.
- Require the Home heading and a settled `#dealAttention[aria-busy="false"]`.
- Switch Just me and Team view; require the selected button's `aria-pressed="true"` and compare the rendered deal entries.
- Use Refresh Home; require settled attention and `#observedAt` without Unavailable or Sign in.
- Read a `#dealFlags a.home-flag` link's `href` and its `strong` title, then click. Require the exact destination, visible `#recordPanel`, and matching `#panelTitle`. Also check the Home navigation link when routing changes.

Calendar & tasks starts with All dates & tasks. Choose Today to show only dates and tasks due on the current day, even when overdue items fill the All preview. Choose Overdue to isolate dated open work before today, excluding held or completed tasks. Undated and future items remain in All. Show all expands the selected view. The seven-day calendar stays unchanged. `test/home-agenda.test.mjs` and `test/home-dashboard-browser.test.mjs` cover Today and Overdue membership, scope, holds, expansion, refresh focus, empty and unavailable states, and phone width. Set `W2_SCREENSHOT_DIR` to retain desktop and phone evidence.

Morning brief queue coverage: `test/morning-brief-queue.test.mjs` and `test/morning-brief-queue-browser.test.mjs`. Open Morning brief, select a named queue, require the returned count, load more, and require the next row in server order. The queue view is independent of the priority owner filter. Needs Joe is Joe-only. Failed pages keep a visible retry and never imply completion.
Morning brief coverage runs in `test/morning-brief.test.mjs`, `test/morning-brief-producer.test.mjs`, `test/morning-brief-browser.test.mjs`, and `test/business-date.test.mjs`. Open Doc, choose Morning brief, and expand each full section. Require the waiting Needs Joe item, all four triage kinds, accounts, providers, and visible partial/unavailable categories. Priority cards retain the full source title and wrap at desktop and phone widths. Opening a card preserves the matching record and Back restores its full title. Summaries remain concise. The brief has no narration controls, including after reloading with a saved speech preference. The browser test retains desktop and phone screenshots under `out/test-artifacts/w12/coverage-*.png`.

Run date checks under both `TZ=UTC` and `TZ=America/Chicago`. Business dates and initial previous-day 17:00 cutoffs use Chicago; date-only fields retain their date. Coverage counts returned rows, not full queue totals. Owner chips scope priority cards; full sections retain the authenticated response's shared work.

The shared walkthrough runs in `test/w1-shell-browser.test.mjs`. Open the account avatar, then How DoctorCRE works. Next and Back explain the highlighted real Home, Local Deals, Leads, Tours, and Doc controls. Done, Skip walkthrough, or Escape closes the guide and returns focus to the avatar. Reopening starts at Home. Run at 390px and 1280px, require visible highlighted targets without overlap, then repeat with reduced motion. The reduced-motion case also resizes the Doc step to a phone and retires the guide on session invalidation. Screenshots stay under `out/test-artifacts/walkthrough/`. The guide is on demand; first-sign-in playback and human content review remain separate work.

## Gotchas

On phones, the loading Calendar & tasks region reserves preview space ahead of independently loaded invoices. Empty and failed reads release that space.

Counts depend on date and scope. Existing tests own their clock and synthetic records. No alerts is a valid Home state but cannot prove deal opening. A failed or partial read must remain visible as such; a shell alone is not readiness.
