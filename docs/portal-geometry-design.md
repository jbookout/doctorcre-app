# Shell geometry

Card: WR227.S10.J2

Before implementation, the data shape is a projected marker rectangle with an
anchor, rendered size and displaced centre. A pure layout returns centres. The
map owns projection and stems. Coordinate rounding cannot detect collisions at
different zooms. Candidate centres form a finite grid sorted by anchor distance.
At saturation the directory remains available and all markers remain represented.

The shell owns one geometry subscription with one pending animation frame.
ResizeObservers measure header and content changes. Scroll events are passive.
Retirement cancels the frame, disconnects observers and restores CSS variables.

Statechart: Tracking → Scheduled on scroll/resize; Scheduled → Scheduled
coalesces events; Scheduled → Tracking measures; either → Retired on disposal.
Retired has no geometry writes. Tests cover each transition through DOM effects.
Progress stays in [0,1]; header height reflects measured geometry; layout keeps
labels apart and inside the viewport while capacity permits.

Layout costs O(n² × viewport grid cells). At 10x density layout and saturation
break first. No external calls, cache, storage, writes, queue or retries are
added. The existing local-map failure circuit breaker remains unchanged.

The statechart above preceded implementation. The later executable model in
`portal-model/Geometry.tla` checks cancellation across five states and eleven
steps. Run the statechart skill with that file and `Geometry.cfg`. TLC verifies
`NoRetiredWrites` and deadlock freedom. Geometry tests check the numerical rules
that the lifecycle model deliberately omits.

Throughput checkpoint: pinned sources and failing tests came first. Geometry,
tracking and styling were separate local changes with serialized verification.
One worker owns the clone and document CSS state. No fan-out was needed or allowed.

Design and debt pass: a combined map controller and separate rectangle layout
were compared. The pure layout wins because tests and the map use the same
geometry interface. It replaces rounded-coordinate grouping and arbitrary
offsets. Header and scroll tracking share one observer lifetime. No compatibility
paths or generic animation framework were added. Reference CSS and private
publication parity remain Studio verification work; these style refinements are
not a claim of exact reference equivalence.
