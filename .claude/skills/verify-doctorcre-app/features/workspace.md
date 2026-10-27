# Workspace

## Sub-features

Partner desktop stage, group zoom, keyboard return, live panel retention and phone restoration.

## How to get to it (user POV)

Open `/ideas-events?ui=react` in the synthetic preview as Joe or Dell. Double-click a visible panel tab bar, or choose a Zoom group button. Choose Return to workspace or press Escape to restore the stage.

## Driving it with Playwright

Run `node --test test/workspace-zoom.test.mjs test/ui-host.test.mjs test/workspace-shell.test.mjs`. The zoom tests verify expanded geometry, original proportions after return, retained drafts, focus, listeners, layout updates and teardown. They also drive Joe and Dell through the actual flagged app and retain synthetic screenshots under `out/test-artifacts/workspace-zoom/`.

## Gotchas

The flag requires a recognized partner and a desktop viewport. The phone keeps its original touch layout. Zoom changes only presentation, without saving a layout or changing split ratios. Docking, nested zoom, overview and remote persistence remain later slices.
