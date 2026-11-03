# Home inbox v3 lifecycle

[The statechart](home-inbox-v3.mmd) was written before the implementation for WR617.S1.J20. The producer owns resolution, snooze expiry and placement. The app reads those states and preserves opaque command authority.

## Acceptance and transition coverage

| Screen transition | Executed test |
| --- | --- |
| Work needs review | `Home refresh transition Work needs review` |
| Processing completes into Done, hide completed update | `Home refresh transition Processing completes` |
| Hide from inbox, Undo hide, hide again | `automatic settlement reasons and lifecycle on Home` at all four widths and both themes |
| Snooze, Wake, snooze again | `automatic settlement reasons and lifecycle on Home` at all four widths and both themes |
| Canonical task, reply, fact review or tour feedback resolves | `Home refresh transition Canonical work resolves`; `v3 accepts canonical resolution of … outside the working list`; `automatic settlement reasons and lifecycle on Home` checks the visible reason and grouping |
| Mark task done, Undo task completion | `Mark done receipt and exact Undo` in `test/home-inbox-browser.test.mjs`, using v3 automatic settlement on completion |
| Show automatically settled card in inbox | `automatic settlement reasons and lifecycle on Home` |
| Snooze expires after resolution | `Home refresh transition Snooze expires after resolution` |
| Canonical work reopens after explicit return | `Home refresh transition Canonical work reopens` |
| Unsupported v3 falls back with a visible limitation | `Home reports v3 unknown_tool truthfully` and its client test |
| Authentication or malformed v3 refuses without hiding the failure | `Home reports v3 partner_required truthfully`, `Home reports v3 malformed truthfully`, and client refusal tests |

The Home browser cases exercise manual settle, snooze, wake, Undo, resolution labels and all five existing Home sections. Existing inbox tests cover bulk actions, lost-response retries, stale versions, exact completion receipts, offline handling and focus. The Home sections tests cover calendar rail fit and contrast at 390, 1024, 1280 and 1440 pixels in both themes.

The parser/client regressions were run before production edits and failed on main. The new UI resolution test also fails on unchanged app main because Home cannot display the v3 snapshot. Existing manual actions already passed on main; they remain regression coverage, rather than manufactured failing assertions.

## Model limits

The statechart is a user-visible lifecycle, not a proof of server resolution rules. Refresh tests supply synthetic authoritative snapshots; they prove the app moves the card and updates its visible state. The producer's PostgreSQL tests own exact grant matching and canonical resolution. No live business records were read or changed.

The statechart tool generated `HomeItem.tla`, `HomeItem.cfg` and `HomeItem.map.mjs` in scratch before code. TLC was initially unavailable through the default Java launcher. With explicit Java 21 and the installed tla2tools jar, the chart checks TypeOK and draws back unchanged. Its summary records 7 model states, 15 model transitions and 14 chart transitions. This checks the chart structure, not production correctness. The chart does not model command retries or concurrent edits; existing receipt tests cover those separately.
