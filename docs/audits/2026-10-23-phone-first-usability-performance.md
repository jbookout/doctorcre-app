# DoctorCRE phone-first usability and performance audit

Date: 2026-10-23

Audited source: `bb1662972e90b928044fc9a5f71c2058f0bea619` (matched GitHub `main` during this audit)

Scope: report only; Home agenda, Leads, deal rooms, Tours, shared load path, offline behavior and accessibility. No application changes.

## Decision and assumptions

Prioritize reliable first paint and continuity of Joe's current task, then reduce repeated reads. The most costly phone failures are a blank screen waiting for a font, losing the person or draft after an interruption, and being unable to open an already-saved tour on weak connectivity. The existing performance budgets pass this local run but permit slow useful-content arrival.

Assume Joe repeatedly opens Home, calls a lead, checks or updates a deal, and opens an existing tour between meetings. Rank by frequency, interruption cost, and recovery effort, with data/draft loss weighted above cosmetic polish. These are engineering judgments, not observed production usage analytics. Estimates are engineer working days including focused regression coverage; they are not commitments and overlapping work should not be summed mechanically.

The repository is public. All examples and probes used synthetic fixtures. No live CARR service, staging application, production application, or database was called. No environment dumps or secret files were read. GitHub access was limited to repository/PR work authorized for this task. Any proposed CARR projection change must use a reviewed versioned contract; this app must not read CARR's database.

## Impact ranking

| Rank | Impact on Joe | Finding | Ship slice |
| --- | --- | --- | --- |
| 1 | High: blank page on an otherwise usable connection | Optional font stylesheet blocks Home, Leads and Deals | A |
| 2 | High: repeated waiting for today's work | Home agenda scales with every active team deal | D1 |
| 3 | High: loses the person after a call | Leads discards the selected record on resume | B |
| 4 | High: retyping and losing place | Deal update draft is erased on reopen; Back leaves the page | B |
| 5 | High: saved itinerary unavailable between stops | Tour day has incomplete/fragile offline recovery | C |
| 6 | High: avoidable delay opening a specific deal | Deep-link serialization, duplicate taps and redundant panel reads | B |
| 7 | Medium-high: cannot distinguish clear from unavailable agenda | Empty and failed Home agendas disappear identically | A |
| 8 | Medium-high: existing tour waits for unrelated clients | Tour library is gated by the full client directory | D2 |
| 9 | Medium: bandwidth/CPU spent below the current task | Leads mounts the territory map before it is needed | D3 |
| 10 | Medium: every route pays for unopened tools | Shared shell eagerly loads and polls optional functionality | D4 |
| 11 | Medium: extra discovery and taps | Phone navigation hides labels; existing tours are in a generic drawer | E |
| 12 | Medium: wrong recovery action on weak signal | Leads labels an initial network failure as sign-in required | A |
| 13 | Medium-low: small precision targets | Some Lead actions fall below the app's phone target convention | A |
| 14 | Indirect but recurring: regressions escape the guard | Performance scenarios omit several of Joe's critical paths | F |

## Measurement and verification boundaries

Read `AGENTS.md` and `README.md` before inspecting implementation. Built the unchanged source with `npm run build` and verified it with `npm run artifact:verify`: 278 artifact files; archive SHA-256 `d413a3cf9cbeffebe4e11c8bb513f8de3cf1698e711a41ebdf94763f76e37dbc`.

Ran the six existing performance scenarios from the built artifact, three cold contexts each: 390×844 touch viewport, 4× CPU slowdown, 150 ms network latency, 200,000 B/s download and 93,750 B/s upload. Used Node 24.19.0 and installed Chromium 154.0.8037.57. A scratch copy of the measurement runner changed only browser launch, local output location and external-request blocking. Browser traffic was limited to loopback fixtures; external fonts and other external resources were aborted. The runner blocks service workers. Scenario definitions are at `scripts/performance-scenarios.mjs:2`; timing/byte collection is at `scripts/measure-performance.mjs:57` and `scripts/measure-performance.mjs:66`.

| Screen / tested interaction | Median LCP | Loaded JS, raw bytes | Script requests, first sample | Median scripted response |
| --- | ---: | ---: | ---: | ---: |
| Home / Just me | 5,056 ms | 610,342 | 61 | 99 ms |
| Deals / open fixture deal | 6,396 ms | 811,777 | 68 | 155 ms |
| Vendors / open record | 3,504 ms | 637,639 | 53 | 333 ms |
| Tours / choose territory | 1,672 ms | 559,011 | 52 | 55 ms |
| Relationships / open person | 1,556 ms | 578,100 | 53 | 113 ms |
| Invoices / aging filter | 4,968 ms | 549,037 | 51 | 70 ms |

These are local lab results, not field Core Web Vitals or production API latency. The fixture server sends uncompressed, `no-store` responses (`scripts/serve.mjs:78`); production asset handling differs (`src/worker.js:97`). Loaded JS is unique script-response body bytes through the scripted interaction, not compressed wire bytes. The response metric is pointerdown to the verified state plus two animation frames, not field INP. Fixtures also load their fixture adapter, so their JS totals are not exact live-mode totals. Aborted fonts make this run different from a stalled font connection, which was probed separately below. Concurrent local audit activity and a different browser/Node version also prevent treating timing differences from the committed baseline as a controlled before/after experiment.

The complete artifact contains **180 JS/MJS files, 4,980,036 raw bytes and 1,440,168 gzip bytes**, summing compression per file using the repository runner. This is the whole shipped artifact, not a single-page download. It includes two MapLibre copies under Tours and Reports; each module/shared/worker set is 1,067,633 raw bytes. `js/ui.generated.js` is 223,870 raw bytes, but its presence in the artifact does not establish that these routes load it. Most first-party modules are copied without minification; the special report compilation and generated UI bundle are at `scripts/artifact.mjs:113` and `scripts/ui-bundle.mjs:17`. Home and Deals shared 49 loaded script URLs / 531,231 raw bytes in the first samples. Optimize critical-path modules and requests before treating the full artifact size as Joe's download.

All measured values passed the committed budget comparator. Home's LCP limit is 5,238 ms and Deals' is 9,600 ms (`contracts/performance-budget.v1.json:35`, `contracts/performance-budget.v1.json:49`). Those are regression limits, not satisfactory user-experience targets.

## Ready-to-ship slices

Each slice is independently reviewable. Preserve authorization checks, stale-data labeling, idempotency and the existing client seam while implementing these recommendations.

### Slice A — First paint and honest, usable states (2–3 days)

**#1 — Optional font CSS blocks the entire screen.**

- **Evidence:** blocking Google Fonts stylesheet links in `workspace.html:16`, `leads.html:9`, and `pipeline.html:15`. Tours already uses preload at `tours/index.html:8`, activated after load by `js/app-shell.js:14`.
- **Verified:** at 390×844, an intercepted font stylesheet held for three seconds left all three affected routes with no first paint and no mounted account/shell control. Aborting the same request allowed first paint in 132–228 ms and fixture content to appear. Tours remained painted with its font request held. The interception never contacted Google.
- **Consequence:** Joe can see a blank app because an optional third-party dependency is slow, even while the app's own assets are available.
- **Concrete fix:** apply the existing nonblocking font pattern to these routes, or self-host the font with a system-font first paint. Add held-font coverage for Home, Leads and Deals; current coverage only names Ideas and Home Charts (`tests/fixtures/font-loading.spec.mjs:4`). **Effort: 0.5–1 day.**

**#7 — An unavailable agenda looks the same as no agenda.**

- **Evidence:** missing detail is recorded as failed in `js/home-dashboard-model.js:55`; the calendar is rendered only when `agenda?.entries.length` is truthy at `js/workspace-command-center.js:59`, then otherwise hidden at `:60`. The partial-data notice is inside the populated branch.
- **Verified:** synthetic all-failed detail reads and confirmed-empty details both produced a hidden Calendar panel with no local explanatory content.
- **Consequence:** Joe cannot tell whether he has nothing scheduled or the schedule failed to load. A page-level partial notice does not explain what happened to the missing agenda.
- **Concrete fix:** always retain a Calendar & tasks region with explicit loading, confirmed-empty, partial and unavailable states and a scoped retry. Only assert an empty schedule after successful reads. **Effort: 0.5–1 day.**

**#12 — A connection failure sends Joe toward login.**

- **Evidence:** the initial identity read is at `js/leads-workspace-app.js:175`; the generic catch at `:215` uses sign-in text when no previous actor exists, and `:134` adds a login link. Explicit authorization handling already exists separately at `:159`.
- **Verified:** a synthetic `network_error` from the initial actor read rendered “Sign-in required · Sign in” and `/auth/login?return_to=%2Fleads`.
- **Consequence:** Joe tries authentication when the problem is weak signal, adding work without restoring the lead list.
- **Concrete fix:** reserve sign-in guidance for explicit 401/403 or confirmed missing identity; show connection failure and Retry for network/deadline failures. Keep writes disabled until identity is valid. **Effort: 0.5 day.**

**#13 — Market filters and the Lead drag handle require precision taps.**

- **Evidence:** `css/leads.css:60` gives `#marketCounts button` a 36px minimum that outranks the shared 44px phone rule (`css/app-shell.css:399`). The drag handle is an `aria-hidden` span (`js/leads-workspace-app.js:36`) with 2px padding and no minimum (`css/leads.css:105`), yet starts pointer dragging (`js/leads-workspace-app.js:474`). The shared rule does enlarge hot-row, Undo/Link and map-marker buttons; those are not findings here. The shared phone convention is 44px (`css/tokens.css:152`).
- **Verified:** local Chromium at 390×844 and 320×844 measured a market chip at 127.58×36px and a drag handle at 13.53×23.5px. Claim, Undo and Link controls measured at least 44px high/wide in those sampled states.
- **Consequence:** quick one-handed market filtering and dragging a lead require more precise aiming than the rest of the interface.
- **Concrete fix:** enforce at least 44×44 CSS-pixel actionable areas on coarse pointers, preserving spacing and separate card actions; retain the select-based stage alternative. **Effort: 0.5 day.** This is a phone usability finding, not a claim that every target violates WCAG 2.2 AA's 24px rule or its spacing exceptions.

**Acceptance:** a held font cannot block paint or primary controls; offline Leads offers Retry rather than login; agenda states remain distinguishable; named actions meet the phone target convention without overlap at 390px and 320px widths.

### Slice B — Keep Joe's current record and draft (3–5 days)

**#3 — Returning from a call closes the Lead Joe was using.**

- **Evidence:** call links exist at `js/leads-workspace-app.js:240`; resume clears the board, `detailId` and detail content, then closes the dialog at `:491–500`. Refresh serially reads actor and workspace at `:175–181`; stage-review drafts have restoration at `:199`, ordinary detail does not. Visibility/BFCache return is wired by `js/read-on-resume.mjs:27`.
- **Verified:** a synthetic persisted `pageshow` changed an open Lead detail to closed with `detailId=null`. Reads were actor → board → detail → actor → board; the detail was not reopened.
- **Consequence:** after using `tel:` or checking another app, Joe must find the same person again to record the outcome.
- **Concrete fix:** retain selected ID and scroll/expansion intent while masking private content. After same-actor revalidation, reread and reopen that eligible lead. Clear intent on actor change, authorization denial or a vanished record. **Effort: 1–2 days.**

**#4 — An unsent deal update is erased on reopen, and phone Back exits the page.**

- **Evidence:** update text lives in `updateDraft` (`js/pipeline.js:797`, `:816`, `:1294`); `openPanel` unconditionally resets it at `:955`. Open and close both use `history.replaceState` (`:956`, `:969`), without a panel history entry.
- **Verified:** closing/reopening a fixture deal erased a typed unsent update. Opening the panel did not increase history length; browser Back returned to Home rather than the deal board.
- **Consequence:** an interruption can cost the note Joe just composed, and familiar phone Back navigation loses his place.
- **Concrete fix:** retain drafts by authenticated actor and deal across panel close/reopen, using the existing local-draft pattern if reload survival is intended; label unsent content and clear on explicit discard/save or identity change. Give panel navigation a history state and handle Back/Forward, including a safe close for direct links. Do not auto-submit a restored draft. **Effort: 1–2 days.**

**#6 — Opening one deal performs avoidable serial and duplicate work.**

- **Evidence:** boot awaits `loadBoard` before honoring the `deal` query (`js/pipeline.js:1370`, `:1377`); `loadBoard` awaits its first change-feed poll (`:373–379`). Card-body click handling calls `openPanel` both at `:1087–1090` and through the bubbled document handler at `:1213–1214`. Board application refreshes an open panel (`:370`) alongside its independent 15-second refresh (`:1371`). Panel reads also load correspondence and relationship context (`:909–924`; `js/pipeline-model.js:429`).
- **Verified:** body tap issued two `getDeal` calls; title-button tap issued one. In a separate quiet 16-second fixture observation after initial detail load, the page client issued 11 change reads, two deal reads, two correspondence-readiness reads, two relationship-network reads and one board read; shell-client reads are additional. These are local adapter calls, not production request timings.
- **Consequence:** opening an exact record waits on unrelated synchronization, and background refreshes spend phone bandwidth and CPU while Joe is reading or writing.
- **Concrete fix:** establish one card-open event owner; start the exact authenticated detail read independently of the broad board/feed; coalesce panel refreshes into one in-flight operation and use change/version information to skip unchanged reads. Fetch full correspondence/relationship context when its section is opened, keeping errors local. **Effort: 1–2 days.**

**Acceptance:** switch away/back from a Lead and keep the same record after revalidation; close/reopen a deal without losing its draft; Back closes a panel opened from the board; one body tap produces one detail request; delaying the change feed does not delay an independently authorized exact-record view. Preserve draft text during refresh and revoke it appropriately on identity change.

### Slice C — Make an already-saved tour dependable (2–3 days)

**#5 — Offline Tour day fails in common partial-connectivity states.**

- **Evidence:** session is read first at `tours/day.js:227`; cached same-tab scope is recovered only when `navigator.onLine === false` at `:244–250`. The shell generator discovers HTML/JS references but ignores CSS imports (`scripts/offline-tour-shell.mjs:14–18`), although `css/app-shell.css:3` imports the required tokens. The service worker handles only manifest-listed paths and uses network-first fallback only after rejection, without a deadline or non-OK-response fallback (`tours/day-sw.js:14–17`).
- **Verified:** with a saved same-tab itinerary and a failed session read, `onLine=true` caused zero cache reads and “Tour unavailable”; changing only `onLine=false` restored the cached tour. Generated shell enumeration returned 69 files / 1,961,568 raw bytes and omitted `/css/tokens.css`. The missing dependency is verified; a visual cold-HTTP-cache offline rendering failure was not measured.
- **Consequence:** Wi-Fi that remains connected without Internet can hide Joe's saved itinerary. A hung fetch can stall cached code, and eviction of ordinary HTTP cache can remove the token-based layout, focus and color styling even with the service-worker cache intact.
- **Concrete fix:** use transport failure, not `navigator.onLine` alone, to permit the existing same-tab binding to restore a dated, explicitly offline itinerary after a short deadline. Keep explicit authentication refusal and sign-out revocation authoritative. Include local CSS dependencies in the current shell generator. Bound network-first shell fetches and fall back for unsuccessful responses, or use the versioned cached shell immediately. Show “Preparing offline” / “Available offline” only when both itinerary storage and shell preparation succeeded (`tours/day.js:235`, `:283`). **Effort: 2–3 days for the combined reliability fix.**
- **Related byte reduction:** install downloads MapLibre assets totaling 1,150,828 raw bytes including CSS, although Tour day passes no basemap style (`tours/day.js:261`) and the map exits before import without one (`tours/itinerary-map.js:277`). Defer those optional cache assets until needed, without deferring required offline dependencies. **Additional effort: 0.5–1 day.** These are cache-install bytes, not initial parser-loaded JS.

**Acceptance:** same-tab cached tour works after timeout while `onLine` remains true; 401/403 and sign-out still revoke it; service-worker-only cache survives an HTTP-cache clear; delayed/503 shell requests have a bounded fallback; an offline-ready indicator reflects actual readiness. Keep the current scoped storage boundary—do not persist authentication authority across new accounts or sign-out.

### Slice D1 — Bound the Home agenda read (3–5 days, cross-repository contract)

**#2 — Home costs N+9 reads before shared-shell work.**

- **Evidence:** `js/home-dashboard-model.js:129` reads the board, `:132–136` fetches every active team deal with four workers, and `:139–143` adds eight other feeds. Agenda dates/tasks depend on those detail records (`:49–66`). `js/workspace-command-center.js:18` and `:143` set a refresh 30 seconds after the previous one settles; `:95–99` impose a 25-second overall deadline.
- **Verified:** a synthetic 40-active-deal board triggered 49 client reads—40 details plus nine primary reads—before shell/secondary-widget activity. This count is independent of fixture API latency; it is not an assertion that Joe currently has 40 deals.
- **Consequence:** the time to learn today's tasks grows with all active team deals, including records Joe is not opening. Multiple four-request waves compete with optional feeds, and slow waves can exhaust the overall deadline.
- **Concrete fix:** agree a versioned, bounded agenda/attention projection with CARR, consumed through `DealRoomClient`. Prioritize that projection and board; load noncritical widgets on visibility or at a slower cadence. Retain progressive rendering, bounded concurrency where needed, explicit partial states and current authorization. An app-only first step can defer optional widgets, but it does not eliminate the per-deal agenda dependency. **Effort: 3–5 days including producer/consumer contract work.**

**Acceptance:** a 40-deal fixture no longer makes 40 detail reads to show the agenda; unrelated slow feeds cannot block it; missing/partial data stays explicit. Bind producer and consumer changes to exact revisions and a reviewed contract as `AGENTS.md` requires.

### Slice D2 — Open existing tours without downloading all clients (1–2 days)

**#8 — A completed tour-library read waits for the client directory.**

- **Evidence:** `tours/planner.js:222–226` awaits both library and clients before rendering; `tours/planner-client.js:64–72` reads client pages sequentially, up to 200 pages. Refresh repeats the work and then reads selected client/open-tour detail (`tours/planner.js:235–256`); the default cadence is 30 seconds (`js/auto-refresh.mjs:10`).
- **Verified:** a resolved synthetic tour library with a pending client-list promise showed zero tour buttons; resolving the client list made the tour appear.
- **Consequence:** Joe's “open my tour” task waits for data needed for a different planning task, and refresh repeatedly spends bandwidth on the full directory.
- **Concrete fix:** render scoped library results independently; fetch client choices only for planning/search using bounded lookup/pagination and a session-scoped cache. Refresh selected records independently, preserving actor/scope invalidation. **Effort: 1–2 days.**

**Acceptance:** an unresolved client-directory request does not delay the existing-tour list; library refresh does not redownload all clients; planning still handles loading/error states and actor changes correctly.

### Slice D3 — Defer below-board map work (0.5–1 day)

**#9 — Leads eagerly pays for territory before Joe reaches it.**

- **Evidence:** map mounting starts at `js/leads-workspace-app.js:490`, before initial refresh at `:503`. `js/leads-territory-map.js:15–20` immediately imports MapLibre and requests geometry/location data. Territory follows the board in `leads.html:22–25`, stacked below it on phones (`css/leads.css:180`, `:187`).
- **Measured source size:** module/shared/worker assets total 1,067,633 raw bytes; geometry/place JSON adds 276,079, totaling 1,343,712. This is asset size, not a measured production transfer or guaranteed savings.
- **Consequence:** opening and filtering leads competes with map download, parsing and rendering without Joe asking to see a map.
- **Concrete fix:** mount near viewport entry or through a named “Show territory” action. Keep the market selector/list available immediately and maintain a useful no-map state. **Effort: 0.5–1 day.**

**Acceptance:** a top-of-page Lead task loads no map engine or territory geometry; revealing territory loads it once and preserves current filters and keyboard access.

### Slice D4 — Slim shared startup and share repeated reads (2–3 days)

**#10 — Unopened tools contribute a large common dependency and polling load.**

- **Evidence:** `js/app-shell.js:1` and `:49` eagerly import/mount Doc; `:145–149` immediately import call-mode code. The static shell dependency closure contains 35 files / 257,091 raw artifact bytes. Doc adds 104,240 unique bytes beyond the other shell import closures; call mode adds approximately 42,950 further unique bytes. These are graph sizes, not guaranteed compressed savings.
- **Request evidence:** `js/doc-presence.js:81–101` and `:151–152` start feature/suggestion/brief activity immediately. Morning Brief reads its payload plus up to four change pages (`js/morning-brief.js:98–112`, `:138`, `:158`). Layout separately reads board, brief and changes (`js/app-layout.js:189–195`, `:224–229`, `:251`), while phone drawers start inert (`:65–68`).
- **Consequence:** route changes pay for optional dialogs, repeated facts and multi-level module requests before Joe opens those controls. The measured Home/Deals shared script footprint makes this a useful cross-screen improvement.
- **Concrete fix:** share same-page board/brief reads and cancellation/scope lifetimes; demand-load optional dialog code at first use. Keep only a lightweight cue if a notification must remain proactive. Bundle/minify coherent first-party entry graphs where it removes waterfall requests, preserving deferred feature boundaries and deterministic artifacts. Do not set long-lived immutable caching on current unversioned asset URLs; introduce content addressing first if changing that policy. **Effort: 2–3 days for deferred dialogs/shared reads; broader asset versioning is separate.**

**Acceptance:** opening Home without Doc/Call Mode does not initialize their full code/data flows; first-open remains responsive; shared reads remain correctly invalidated on resume, failure and actor change. Compare critical-path request count and bytes before/after on the same fixture/browser profile.

### Slice E — Make phone destinations visible (2–3 days)

**#11 — The interface hides the labels and the most useful existing-tour entry.**

- **Evidence:** primary links use abstract glyphs such as ◎ for Leads and ◇ for Tours (`js/navigation.js:18–25`), and `css/app-shell.css:99` visually clips their labels. Accessible names and target sizes exist. “Your tours” is assigned to a sidebar (`tours/index.html:60–65`), moved by `js/app-layout.js:42–46`, and starts closed/inert on phones (`:58`, `:65–68`). Its opener is labeled generically “Workspace sidebar” (`:18`). Initial main content emphasizes Territory, planning and search (`tours/index.html:17–59`); Tour day follows tour selection in a dialog (`tours/planner.js:165–169`).
- **Verified/observed:** local 390px screenshots show the icon-only primary rail; the tour entry sequence is source-traced, not a timed user study.
- **Consequence:** a sighted phone user cannot rely on hover titles, and “open today's tour” requires discovering a generic drawer before selecting the tour and Tour day.
- **Concrete fix:** use visible labels for Home, Leads, Deals and Tours with More for secondary destinations, preserving account access and accessible names. Put a compact “Next tour / Your tours” entry in the phone main view, with a direct Tour day action when applicable; retain the full library elsewhere. **Effort: 0.5–1 day for labels, 1–2 days for tour entry.**

**Acceptance:** at phone widths Joe can identify the four principal destinations without memorizing glyphs, and reach an existing Tour day through a visibly named primary path. Verify focus order, safe-area clearance, zoom and 44px targets after the layout change.

### Slice F — Guard the tasks Joe actually performs (1–2 days)

**#14 — The current performance guard misses several important outcomes.**

- **Evidence:** `scripts/performance-scenarios.mjs:5–11` measures six screens but omits Leads. Home checks a deal-flag scope toggle, Tours checks territory selection, and Deals checks that an update form is visible. The runner blocks service workers (`scripts/measure-performance.mjs:40`) and does not exercise tour offline readiness or resume/draft continuity. Budget headroom explicitly preserves existing slow screens (`contracts/performance-budget.v1.json:29`).
- **Consequence:** CI can remain green while a call return loses context, the next tour waits on unrelated data, or a saved tour fails offline. A fast territory tap does not establish a fast tour workflow.
- **Concrete fix:** extend the existing fixture suite and budget scenarios with agenda-ready, Leads open/call-return, exact deal link, draft-preserving panel navigation, tour-library ready and saved-tour offline cases. Measure time to the useful record/agenda, request counts and critical bytes alongside LCP. Include delayed reads and larger synthetic datasets. Keep this in the existing tooling; no new benchmark service is needed. **Effort: 1–2 days**, with behavioral regressions preferably added alongside the corresponding slices.

**Acceptance:** each repaired failure has a focused regression, and budgets explicitly cover Leads and the existing-tour path. Record baseline source/browser/conditions; do not raise limits simply to make a repair pass.

## What is sound and should be preserved

- **Clear data boundary and lightweight boot choices.** Home starts its client asynchronously and imports only the chosen live or fixture adapter (`js/home-boot.js:1–20`). Build artifacts bind source and contract digests and passed source verification. Current unversioned HTML/JS/CSS use `no-cache`, which permits validation rather than indefinite stale reuse (`src/worker.js:102`).
- **Progressive Home data and bounded work.** Independent feeds publish progressively, individual reads have deadlines, and detail concurrency is four (`js/home-dashboard-model.js:100–145`). The six-item agenda preview expands locally (`js/workspace-command-center.js:15`, `:59`, `:136`). These are useful foundations even though total request count is too large.
- **Read lifecycle safeguards.** Shared refresh pauses while hidden/idle, coalesces a running read and uses deadlines/backoff (`js/auto-refresh.mjs:10–55`; `js/visibility-poll.mjs:18–34`). The problem is excessive independent readers or destructive resume behavior in particular consumers, not an absence of lifecycle handling.
- **Deal accessibility in sampled states.** At 390×844, local Chromium/axe checks found zero violations for color contrast, labels, button/link names, dialog names and target-size rules on the deal board and open detail in both dark and light themes. Visible controls in those sampled states were at least 44px in both dimensions and no horizontal overflow was found. This does not certify all dialogs, long data, zoom levels, VoiceOver or TalkBack. Deal detail has native modal semantics and focus restoration (`pipeline.html:98`; `js/pipeline.js:960`, `:973`).
- **Readable theme roles.** Calculated opaque token pairings were 5.77:1 for quiet text on dark surface-3, 4.66:1 on light surface-3, and 7.08:1 for action text on orange (`css/tokens.css:18–31`, `:61–74`). These pairs meet normal-text AA; composited states still require rendered checks.
- **Alternatives to dragging and cautious writes.** Leads offers a native stage select and labeled confirmation fields (`js/leads-workspace-app.js:241`, `:273–313`). Mutations carry expected actor, version and idempotency keys (`js/leads-client.js:60–70`); unknown writes are not automatically resent (`js/leads-workspace-app.js:380–387`). Live writes refuse known-offline attempts (`js/live-client.js:66–75`). Keep these properties when speeding up the UI.
- **Tour-day capture is deliberately local.** It honestly reports “Saved on phone · Filing unavailable” (`tours/day-store.js:41–44`; `tours/day-client.js:16–18`). Missing upload/transcription is a capability boundary, not a newly discovered broken sync promise. Capture freezes property/route identity before microphone permission, persists chunks and supports failure recovery (`tours/day-recorder.js:8–29`, `:37–70`); page hide stops recording (`tours/day.js:289`).
- **Offline privacy and tour usability foundations.** Tour auth refusal clears displayed state and saved tab authority (`tours/day.js:215–220`, `:242`); its service worker excludes session/API records, provider tiles and audio (`tours/day-sw.js:1–2`, `:14`). Day controls have 48px minimum height and phone capture controls 60px (`tours/day.css:10`, `:125–132`); current-property content precedes the map on phones (`:119–122`). Ordered stops remain available without a street map, and navigation is gated by accepted route information (`tours/itinerary-map.js:119–132`, `:217–235`).

## Checks, limitations and pre-PR review

Completed locally:

- `npm run check` — TypeScript, repository constraints and UI copy checks passed.
- `npm run docs:check` and `git diff --check` — passed for the report; source file/line references were also checked for existence and range.
- `npm run build` and `npm run artifact:verify` — passed against the audited source.
- Adapted loopback-only performance runner — all 18 samples completed; the existing budget comparator passed all screen and artifact metrics.
- `node --test --test-concurrency=1 test/home-dashboard.test.mjs test/home-review.test.mjs test/home-call-actions.test.mjs test/leads-workspace.test.mjs` — 4/4 test files passed.
- `node --test test/tour-day.test.mjs test/tour-day-regressions.test.mjs test/w6-planner.test.mjs test/offline-tour-shell.test.mjs` — 4/4 test files passed.
- Synthetic targeted probes verified font blocking, Home read count and agenda states, Lead resume/error behavior, deal duplicate opens/draft/history behavior, planner gating and same-tab offline recovery. Chromium axe checks covered only the deal board/detail states described above; separate Lead geometry checks covered 320px and 390px widths.

No live service latency, production volumes, field INP, battery measurements, physical iOS/Android browser behavior, screen-reader session, or cold-cache offline visual rendering was measured. General Home/Leads/deal offline availability should not be inferred from Tour day's dedicated cache: fresh reads still require connectivity, and cached shell bytes do not establish cached authorized business records. No blanket offline-readiness claim is made. Larger lead-search rendering cost is a follow-up measurement candidate: each input currently rebuilds multiple sections (`js/leads-workspace-app.js:75–110`, `:392`), but no production-volume input latency was measured.

Repository workflow note: sized as a medium, report-only audit. The locally referenced `grill-with-docs`, `poteto-mode`, `codebase-design`, `zero-tech-debt`, `tdd`, and `diagnosing-bugs` skill files were not installed in the available agent skill locations; searched local skill catalogs as instructed by `AGENTS.md:59`. No application code was written, so no implementation TDD cycle was needed. Performed a manual design/debt pass on this documentation-only diff: recommendations reuse existing refresh, client, cache and fixture seams; the one cross-repository agenda projection is explicit; no new framework, compatibility layer, durable application-data store or committed harness is proposed. This is a single dated audit requested by the user, not a replacement domain database. Draft PR publication is the authorized endpoint; merging or deployment is outside this task.
