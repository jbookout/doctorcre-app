# Deal update summary interaction

The pipeline owns the selected deal and retires the island before replacing it. The typed parser refuses wrong identities, unsupported enums, broken ordering and mismatched revisions. The controller owns two independent loading channels, one source revision, manual continuation and retirement. The DOM view keeps its native history disclosure and keyboard trigger across updates. Producer prose is displayed verbatim.

The graph is an abstraction of visible loading states. TLC checks graph reachability and TypeOK, not network cancellation, source hashes, page content or authorization. Executed behavior tests establish those properties. Summary and history share producer responses, while requests and errors remain independent. A history response also supplies a summary at its own revision. An older independent summary cannot replace it.

Regenerate in scratch, then copy the source, TLA, config, stories and summary back. The JavaScript mapping remains a generated scratch artifact.

```
mkdir -p /tmp/deal-summary-model
cp docs/models/deal-update-summary/history.mmd /tmp/deal-summary-model/history.mmd
JAVA=/opt/homebrew/opt/openjdk@21/bin/java TLA2TOOLS=/tmp/J79-tla2tools.jar node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs from-chart /tmp/deal-summary-model/history.mmd
```

Each graph edge has a named executable test in `test/deal-update-summary.test.ts` or `test/deal-update-summary.browser.ts`.

| Edges | Test |
| --- | --- |
| Summary arrives; expand history; first page arrives; next page arrives | summary and history load independently; ordinary continuation failure keeps rows and retries |
| Summary fails; retry summary | initial read error retries and old summary never accompanies newer history |
| First page fails; retry history | history first-page failure retries independently of ready summary |
| Load older; ordinary failure keeps rows; retry older | summary and history load independently; ordinary continuation failure keeps rows and retries |
| Stale cursor replaces pages; refresh source; refresh replaces revision | stale cursor replaces pages with fresh revision; refresh keeps expanded |
| Collapse returns focus | Overview uses one source summary, exact pages, retained originals, retry, stale refresh and focus in four viewports |
| Leave deal; lose session in every region | retirement and cross-deal identity fence late success and failure; authorization clears rows; pending continuation success and failure cannot survive retirement or a new refresh; retirement clears every settled summary and history state |

The registered producer recording and description are copied without modification from CARR PR 3202 at `b04d48ac427b11f50b2d60a53d83733b9cee0d98`. `contracts/deal-update-summary.v1/provenance.json` binds their SHA-256 digests. Browser variants rebind the synthetic deal ID and add a long original, retaining the producer structure and passing every variant through the production parser.
