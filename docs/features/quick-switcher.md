# Quick switcher

Card: WR617.S11.J3

Control Room keeps Cmd/Ctrl+K, exactly as on main. Doc keeps Cmd/Ctrl+D.
The global switcher uses Cmd/Ctrl+Alt+K. Its button advertises the same shortcut.
Cmd/Ctrl+Shift+K was rejected because Edge on Windows reserves it for Duplicate
Tab. The Alt variant is unused by app keydown handlers and is not listed in the
published [Chrome](https://support.google.com/chrome/answer/157179),
[Safari](https://support.apple.com/guide/safari/keyboard-and-other-shortcuts-cpsh003/mac)
or [Edge](https://support.microsoft.com/en-us/edge/keyboard-shortcuts-in-microsoft-edge)
shortcut tables. Safari coverage applies to macOS. Chrome and Edge tables cover
macOS and Windows. User remappings and extensions can still claim shortcuts.
The handler uses physical KeyK so Option-generated characters on macOS work.
Composition events, including keyCode 229, and AltGraph pass through. Printable
Ctrl+Alt characters in editable fields also pass through. Composing Enter
never chooses a destination.

The switcher is a lazy island over the authorized board, relationship network
and navigation registry. Recents retain only destination IDs in session storage
and intersect them with fresh reads. Labels are never persisted.

```mermaid
stateDiagram-v2
  [*] --> closed
  closed --> loading: Cmd/Ctrl+Alt+K or Search control
  loading --> open_empty: read completes, blank query
  loading --> typing: read completes, matching query
  loading --> no_results: read completes, unmatched query
  loading --> error: read fails
  error --> loading: Retry
  loading --> navigating: choose page
  error --> navigating: choose page
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
Arrow keys wrap while focus stays on the combobox. Native dialog excludes background Tab targets.

Two designs were considered. The full Search page preserves broad search but
its producer does not supply navigable deal links. The chosen local index gives
instant filtering over existing navigable reads without a new server contract.
Board actions supply task destinations. Contacts open their relationship node.
The model excludes transport and destination authorization checks, which remain
with the authenticated adapters and destination pages.

Named regression coverage in `test/quick-switcher-browser.test.mjs`:

- `held read completes with needle/absent query and clears to pages` covers delayed matching, delayed no-results and clearing to pages.
- `<phase> closes with Escape/outside and restores focus` covers both close paths in loading, error, open_empty, typing and no_results.
- `loading/error page result navigates with Enter` covers available page navigation before a successful record read.
- `arrow selection wraps exactly and Tab excludes background controls` covers both arrow directions, wrapping and focus containment.
- `global switcher preserves <variant> text entry` covers AltGraph, printable editable fields and both composition signals.
- `composing Enter preserves switcher before normal Enter` covers the composition self-transition and ordinary navigation afterward.
