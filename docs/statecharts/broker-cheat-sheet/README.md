# Broker cheat sheet

The app stores broker notes separately from the generated itinerary in each immutable CARR sheet revision. Regeneration reads current accepted route facts, preserves notes and appends through the existing autosave contract. History is read-only and displays the latest 100 revisions.

The model checks session retirement during editing, saving, conflict recovery, regeneration and history viewing. It does not model network scheduling, database isolation, note text or fact values. Browser acceptance tests cover those values and verify that writes target only the sheet endpoint.

To regenerate, copy broker-sheet.mmd into a scratch directory and run the installed statechart skill's `statechart.mjs from-chart` command with `--png`. Set TLA2TOOLS to the installed tla2tools.jar. The accompanying summary and stories record the executed model result.

The two interface candidates were a single generated text document and separate notes plus generated facts. Separate fields preserve notes without unreliable text merging. The existing versioned save, replay and conflict machinery remains the only write path.
