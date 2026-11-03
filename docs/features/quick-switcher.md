# Quick switcher

Card: WR617.S11.J3

The switcher is a lazy island over the authorized board, relationship network
and navigation registry. Recents retain only destination IDs in session storage
and intersect them with fresh reads. Labels are never persisted.

```mermaid
stateDiagram-v2
  [*] --> closed
  closed --> loading: shortcut or Search control
  loading --> open_empty: read completes, blank query
  loading --> typing: read completes, matching query
  loading --> no_results: read completes, unmatched query
  loading --> error: read fails
  error --> loading: Retry
  open_empty --> typing: type
  typing --> no_results: unmatched query
  no_results --> typing: matching query
  typing --> open_empty: clear
  no_results --> open_empty: clear
  open_empty --> navigating: choose
  typing --> navigating: Enter or click
  navigating --> closed: navigate
  loading --> closed: Escape or outside click
  error --> closed: Escape or outside click
  open_empty --> closed: Escape or outside click
  typing --> closed: Escape or outside click
  no_results --> closed: Escape or outside click
```

Close always restores the opener. Session invalidation closes and retires the
island, clears recents and discards late reads. New opens revalidate data.
Arrow keys wrap while focus stays on the combobox. Native dialog contains Tab.

Two designs were considered. The full Search page preserves broad search but
its producer does not supply navigable deal links. The chosen local index gives
instant filtering over existing navigable reads without a new server contract.
Board actions supply task destinations. Contacts open their relationship node.
The model excludes transport and destination authorization checks, which remain
with the authenticated adapters and destination pages.
