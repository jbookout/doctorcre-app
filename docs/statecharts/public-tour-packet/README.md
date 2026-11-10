# Public packet model

`Chart.tla` models the public share page's access and document regions.
`../public-tour-packet.mmd` is the agreed chart. The model excludes server PDF
jobs, share-grant creation, browser internals, and retraction of saved files.

With Java 11 or newer and the official TLA+ `tla2tools.jar`, reproduce the check
from this directory. Set `JAVA` and `TLA2TOOLS` to their installed paths.

```sh
"$JAVA" -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config Chart.cfg Chart.tla
```

J2 checked TypeOK, RefusedPacket, and RefusedPrint. The statechart tool reported
four model states and six transitions, with no broken rules. Evidence and the
regeneration output are under `/tmp/WR12.S1.J2-statechart/` in the builder session.

Unavailable access with an empty document is an intentional terminal state.
`CHECK_DEADLOCK FALSE` permits that terminal state and does not disable invariants.

The model assumes that access invalidation clears the packet atomically. The
browser privacy tests exercise that clearing. Native print-dialog dismissal is
an environmental assumption, not an automated browser test.
