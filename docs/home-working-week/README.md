# Home working week

Home shows seven Chicago business days beginning with today. The app reuses `homeWeek`, `readHomeAgenda`, and `agendaSnapshot`. CARR remains the owner of recorded meetings, tasks and deal dates. A returned meeting has no confirmed deal destination, so its detail shows the meeting without a guessed deal link. Dated work opens the returned deal ID.

## System design

The existing layout refresh owns requests, cancellation and its refresh budget. One extra bounded `read-home-agenda` snapshot runs beside existing reads only on Home. There is no per-deal fan-out, polling loop, write, queue, retry loop or persistent content cache. At ten times the present row count, the snapshot and seven-day model remain linear in returned rows. The producer's bounded snapshot and response size remain the first capacity limit.

The calendar panel validates the calendar response at the existing seam. `readHomeAgenda` applies its existing producer parser. The typed working-week module owns viewed day, open detail, focus restoration and retirement. The URL keeps only the chosen date; browser history keeps only the returned focus key. Source content stays in memory. Missing feeds replace affected content and show unavailable labels. Partial meetings remain visible with coverage notes. Changed selected rows close their detail; unchanged refreshes preserve it. No unreturned date range is described as available.

Two designs were considered. Mounting the legacy HTML renderer directly would preserve its click delegation and separate DOM state. A typed module that reuses its pure model fits Home's React ownership and isolates detail state behind render and retire. The latter keeps one date and ordering implementation without rewriting the legacy workflow page.

## Throughput checkpoint

- Blocking first steps. Read scope, producers and standing orders; model lifecycle; prove missing Home view with a red browser test.
- Independent workstreams. None delegated because the worker brief forbids subagents.
- Shared mutable state. One worktree and one owner; local view state belongs to the typed module.
- Smallest safe decomposition. One vertical slice shares the existing layout read lifetime and calendar bundle.

## Statechart and tests

`week.mmd` is the lifecycle abstraction. It leaves out transport internals, dates, row counts and the producer's own state machine. Browser tests execute the real module and canonical fixture client responses through the production parsers. `home-week.test.mjs` covers Chicago midnight, DST, all-day dates, coincident identity and instant ordering.

| Transition | Browser test |
| --- | --- |
| choose day | Home working week preserves day, exact details, coverage and retirement |
| open returned item | Both Home browser tests; proof checks every returned row |
| close or Escape | Both Home browser tests |
| selected source changes | working week refreshes, replaces selected sources and refuses retired late reads |
| refresh sources | working week refreshes, replaces selected sources and refuses retired late reads |
| refresh unchanged sources | working week refreshes, replaces selected sources and refuses retired late reads |
| feed incomplete | Both Home browser tests |
| feed recovers | working week refreshes, replaces selected sources and refuses retired late reads |
| session ends from day or detail, available or partial | Both Home browser tests |

Run the model from a scratch copy of `week.mmd` with `JAVA=/opt/homebrew/opt/openjdk@21/bin/java TLA2TOOLS=/tmp/J307-model/tla2tools.jar node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart /tmp/WR591.S7.J1-model/week.mmd --png`. TLC checks both retirement invariants. Browser tests remain the evidence for actual DOM behavior.

## Production proof

Run `node scripts/prove-home-working-week.ts --origin https://app.doctorcre.com --expected-commit <merge-commit> --cdp-url <signed-in-CDP-endpoint> --screenshot-dir /tmp/WR591.S7.J1-production-shots --timeout-ms 30000` after deployment. Exit 0 requires a containing release, both an existing meeting and dated work, exact rows for every covered day, exact start/end attributes and deal destination, detail return and focus at 1440 and 390 in both themes. Exit 1 means an assertion failed on a containing release. Exit 78 means insufficient release, session or cohort evidence. It reads the registered producers independently in the same signed-in session and performs no business writes. Current-week interaction is the proof boundary; arbitrary historical or future meeting coverage remains outside this slice.
