# Research attention model

The adjacent Mermaid source separates attention, finding kind, subject authorization,
rendered evidence, the last observed event, and requests added by that event.
The last two regions record observations for the rules. They are not new UI state.
Each event is independent. A zero match is the observable result of a selector change.
The model starts with one authorized lead and recorded research already loaded.

`ResearchAttention.cfg` checks TypeOK and seven behavioral invariants. The TLA+
model refines the generated chart with all four attention values, two subject IDs,
and pre-event observations. Every action condition cites the existing code.
`researchSubject` corresponds to the workspace's rendered research owner.
`detailId` represents the current selected subject. The pre-event fields are proof
observations, not proposed runtime fields. `calls` records requests added by this
event, so an already-pending read is allowed while filtering.

The chart collapses nondefault attention values into Attention selected. TLC still
checks correction, expired, and nothing independently. The two subject IDs stand
for arbitrary different leads. Epoch equality is abstracted to two values; actor identity is either the current
partner or another actor. LateReadArrival accepts only a mismatched epoch or
actor, matching the real response guard. It overapproximates the possible stale
responses without modeling the network queue. A late arrival means an obsolete epoch or actor,
rejected before paint at `js/leads-workspace-app.js:401`. Reset and successful
read/paint are modeled at their observable completion. Network scheduling,
intermediate loading screens, producer correctness, individual evidence rows,
kind values, dates, and proof-browser ownership are outside this model.
Executable browser and contract tests cover those concrete projections.

The state and next_step strings are abstract fixture values. ZeroMatchGuidance
compares their pre-event and post-event values, rather than assuming an empty
projection is verified research. Missing research is outside the starting model
and remains the renderer's unavailable state at `src/ui/lead-research.tsx:36`.

To regenerate, work outside the repository. Preserve the refined model next to
the copied chart because from-chart retains an existing TLA+ model.

```sh
mkdir -p /tmp/research-attention-check
cp docs/statecharts/research-attention.mmd /tmp/research-attention-check/
cp docs/statecharts/research-attention/ResearchAttention.* /tmp/research-attention-check/
TLA2TOOLS=/tmp/review800-statechart/tla2tools.jar JAVA=/opt/homebrew/opt/openjdk@21/bin/java \
node /Users/booko/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/statechart/scripts/statechart.mjs \
  from-chart /tmp/research-attention-check/research-attention.mmd
```

The jar path names the official TLA+ release jar used for this review round.
A reviewer can supply another installation through TLA2TOOLS and JAVA.
The command must report all eight invariants holding and draw the chart back
unchanged. `summary.json` and `stories.md` are the machine-readable counts and
rule results. A fresh generation without the refined files checks the seven
chart rules as well. The refined model strengthens retention to exact attention
identity, late reads to both subject identities, and zero matches to exact
state and guidance preservation.

| Event | Executable test |
| --- | --- |
| Initial authorized panel | research attention projection and lifecycle, all four width/theme cases |
| select attention | research attention projection and lifecycle, exact subsets |
| clear attention | research attention projection and lifecycle, kind retained |
| select kind | research attention projection and lifecycle, intersection |
| clear kind | research attention projection and lifecycle, all kinds restored |
| same lead refresh | research attention projection and lifecycle, detail and workspace refresh |
| same lead repaint | research attention projection and lifecycle, correspondence repaint |
| lead change | attention lead change resets both selectors and rejects a late read |
| authorization retirement | attention authorization retirement resets both selectors and rejects a late read; default All is covered by research resumes when the suspended dialog close arrives before identity |
| disposal | attention disposal resets both selectors and rejects a late read; default All is covered by attention disposal clears rendered dates and ignores a late detail response |
| disposal from signed out | attention disposal after authorization retirement resets both selectors and rejects a late read |
| authorized reopen | attention authorization retirement resets both selectors and rejects a late read |
| late read arrival | all four named attention boundary tests above |
| zero match | research attention projection and lifecycle, exact unchanged state and next_step |

Each row covers that event's arrows across every region. The projection test's
full names end in `390 light`, `390 dark`, `1440 light`, and `1440 dark`.

The full generated graph exceeds Chromium screenshot capacity at the skill's
default scale 2. Render the identical generated source at scale 0.25 instead.

```sh
npx --yes @mermaid-js/mermaid-cli \
  -i /tmp/research-attention-check/ResearchAttention-statechart/chart.mmd \
  -o /tmp/research-attention-check/model-chart.png -s 0.25
```
