# Home working disclosure

The [chart](home-working-section.mmd) was written and compiled before the UI change for WR617.S1.J60. Disclosure and card placement change independently. Closed Empty and Hidden states have no rows. Selected remains reachable in either disclosure state. Search filters membership without opening the section. Remount closes it. Refresh keeps the mounted disclosure choice.

Slice owns a local boolean and a typed display mode. HomeSections owns grouping over parsed readonly InboxItem data and the current/pinned projection. CARR owns source state and receipts. Other slices retain their preview. No persistence, producer, request, retry, cache, queue, or storage rule changes. Filtering stays linear within the existing 1,000-card snapshot limit. At ten times upstream load the existing truncation indicator remains the limit. Home retains its stale/refusal behavior.

## Transition coverage

Every arrow with the following label maps to these browser tests in `test/home-sections-browser.test.mjs`. Width/theme suffixes run at 390px and 1440px in light and dark.

| Transition label | Test name |
| --- | --- |
| Initial empty / closed populated | working section closed with 0 cards; working section closed with 1 cards; working section closed with 3 cards |
| Open section / Close section | working disclosure keyboard search refresh remount; single working card exposes a disclosure; closed working section preserves selected card without first preview |
| Refresh cards | working disclosure keyboard search refresh remount |
| Search cards / Clear search | working disclosure keyboard search refresh remount; closed working section preserves selected card without first preview |
| Select card | closed working section preserves selected card without first preview |
| Work needs review / Work resolves | closed working refresh moves attention and resolved cards |
| Remount Home / Invalidate session | working disclosure keyboard search refresh remount |

The [existing lifecycle chart](home-inbox-v3.mmd) and `test/home-inbox-v3-browser.test.mjs` retain canonical resolution, completion reason, hide, snooze, wake, and undo coverage. The loaded-search suite explicitly opens working before comparing all placements.

## Model rules and limits

The chart compiler checks OrdinaryClosed and SearchClosed. The refined scratch model additionally checks SelectedReachable, AttentionOutsideWorking, DisclosureNoRPC, and RefreshKeepsChoice. These encode the five never rules: ordinary rows never appear closed; selected rows never disappear because of disclosure; attention never stays in working; toggles never request an RPC; refresh never resets manual expansion. SearchClosed separately checks filtered visibility. Each rule also has rendered browser assertions above. The no-RPC browser assertion observes actual inbox calls; a model cannot prove network behavior by itself.

The scratch model is `/tmp/WR617.S1.J60-model/HomeWorkingSection.tla`, with its config, labels, stories and summary beside it. Regenerate the base model by copying the chart to scratch and running `node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart /tmp/WR617.S1.J60-model/home-working-section.mmd`. Supply `TLA2TOOLS` and `JAVA` for an installed TLC and Java runtime. This checks structure, not producer correctness, authentication, retries, concurrency, or production data. Browser tests use synthetic snapshots passed through production parseSnapshot.

The display pattern follows T3 `apps/web/src/components/Sidebar.tsx`, commit `9e85538535c8553901351112ab02dd1dd62db5ee`, specifically route-only closed shelves and visible counts. This is a small new expression, with no copied runtime or settlement policy.

## Production proof

After a containing deployment, independently read `/app-release` with the existing release reader and verify source containment of the merge SHA. In the signed-in proof browser compare natural parsed read-home-inbox-v5 working IDs/count with closed, opened and closed Home at both widths. Follow an existing exact-card link. Zero natural working cards means insufficient evidence. Do not mutate business records for this display proof. Full AC-INBOX also needs the historical canonical source receipts and persisted disposition observations specified in the J59 plan. Local fixtures do not establish that criterion.
