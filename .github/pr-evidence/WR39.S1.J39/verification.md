# Detail Undo accessibility verification

Card: WR39.S1.J39

Base bdb0d0a1 includes merged app PR 617 at 15fe7635.

The new tests ran against the unchanged main controller before the fix.
All 12 failed for the intended reasons. Eight observed body focus while
Undo was disabled. Four observed an empty success announcement after the read.
See failing-main.log for the captured output with trailing whitespace removed.

After the fix, all 66 doc-activity tests pass with no skips. The four
width and theme pairs cover pending Undo, successful Undo, 504 Check undo,
focus retained on another dialog control, completed post-Undo reads,
a subsequent background read, and manual Refresh clearing the old message.
The existing removed-event tests still verify dialog close and next-row focus.
One previous body-focus assertion now expects the dialog Close control.

The four PNGs show the surviving event dialog after successful Undo.
The 390 dark screenshot was inspected. DOM assertions verify focus and
role=status with aria-live=polite. Actual screen-reader speech was not tested.

npm run check and npm run lint both passed. Dependencies were installed with
npm ci --ignore-scripts. node scripts/prepare-offline-tour.mjs ran first.
The typed-surface checker takes a positional base; use origin/main, not --base.

Design and debt pass keeps focus policy in paintDetail and message lifetime
in the existing message helper. No new public interface, timer, request,
compatibility path, or application comment was added. The no-comments audit
was performed locally because this brief prohibits subagents.
