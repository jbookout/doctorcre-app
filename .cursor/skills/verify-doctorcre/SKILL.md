---
name: verify-doctorcre
description: "Launch and drive DoctorCRE's local web UI with Playwright and synthetic fixtures; use to prove mapped user behavior or reproduce a regression with retained evidence."
---

# Verify DoctorCRE

Read [the feature index](features/README.md), then the matching feature file. Run
all lifecycle steps in order. This skill controls the app's browser surface;
it does not certify live CARR service behavior.

## Launch

From the repository root, install dependencies once with `npm ci` and install
Chromium with `npx playwright install chromium`. Use Node 22.12 or newer and
the local POSIX `ps` and `lsof` commands (available on macOS and hosted Ubuntu CI).
Generate the repository's slice-owned routes with `npm run slices:check`.

Choose a fresh run directory. The executable CLI starts the repository's
`scripts/serve.mjs` fixture server on an OS-assigned loopback port:

```bash
export VERIFY_RUN="$PWD/out/verify-doctorcre/first-run"
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs launch --run "$VERIFY_RUN"
```

Require exit 0 and the reported local origin. The server's readiness line is
`DoctorCRE fixture server: http://127.0.0.1:<port>`. Launch records its PID,
ownership nonce, source revision, and source file hashes in `scratch/state.json`.
Never attach to an existing server or change the origin to a remote host.

Each run has its own port, scratch directory, and isolated browser contexts.
Two runs can operate side by side; use distinct run directories. A second launch
into an active run refuses. No partner login, API key, or production data is needed.

For a historical checkout, prepare its slices there, then pass its absolute
path with `launch --root <checkout> --run "$VERIFY_RUN"`. The helper and Playwright
come from this checkout; the app comes from the named historical checkout.

Teardown is the `cleanup` command below. Run it after failed iterations too.

## Doctor

```bash
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs doctor --run "$VERIFY_RUN"
```

This read-only check requires the owned process and its loopback listener,
fixture release identity, source hashes, and served boot-module bytes to agree
with the launch record.
It cannot authenticate a live CARR instance. Run it before the first drive and
after any surprising result. A failed check blocks driving: capture the diagnostic,
cleanup, and launch a fresh run after correcting its cause. If the server is healthy
but the UI is wedged, use a new drive's isolated browser context or relaunch.

## Drive

```bash
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive home --run "$VERIFY_RUN"
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs drive all --run "$VERIFY_RUN"
```

The feature IDs are in [the index](features/README.md). Each recipe uses Playwright
to open the app, operate its visible controls, and assert the resulting user state.
It exercises the listed navigation and bookmark paths with stable ARIA labels,
route paths, and existing IDs. It does not call internal setters or test-only endpoints.

The browser refuses requests outside the owned origin and records those attempts.
External fonts or map resources can be blocked; the proof must state that limitation.
Service workers are blocked so a cached or background path cannot escape this guard.
Synthetic responses are supplied only at the app's existing CARR HTTP/MCP seams,
using repository fixture data. Static product modules and page markup are served
by the local app server. No production calls, messaging, paid model calls, or host
microphone capture belong to these recipes.

If a recipe fails, retain the failed action and result; run `doctor`, then `cleanup`
before another launch. Never label an unexercised entry point as passed.

## Evidence

```bash
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"
```

Evidence lives in `$VERIFY_RUN/evidence/`, separate from scratch. Each drive records
its feature, exercised entry points, source revision, actions, assertions, requests,
browser errors, screenshots, ARIA snapshots, and Playwright trace. The manifest
binds file bytes with SHA-256; `evidence` reads the files and checks their hashes.
A valid manifest for a failed drive proves the failure was preserved; it does not
turn that drive into a passing behavior check. Read the drive's `result.json` verdict.

The checked-in [proof record](proof/verification.json) binds the initial six-feature
lifecycle and the historical regression comparison to source and helper hashes.
`proof/verified-runs.tar.gz` retains those runs' complete evidence directories,
including manifests, traces, screenshots, ARIA snapshots, and lifecycle output.

Proof standards:

- Exercise the user path, including every entry point listed for the feature.
- Capture the action and resulting state; keep before/after screens and the trace.
- For persisted drafts, reload and read the fields from the app again.
- For in-memory deal mutations, open the record as a second view; do not claim
  durable CARR persistence from the fixture adapter.
- Observe skipped external work through recorded requests and blocked attempts.
  Do not infer safety from a flag named fixture or dry-run.
- Report any unreachable path with its attempted route and missing prerequisite.

## Cleanup

```bash
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs cleanup --run "$VERIFY_RUN"
.cursor/skills/verify-doctorcre/verify-doctorcre.mjs evidence --run "$VERIFY_RUN"
```

Cleanup stops only the server whose PID and ownership nonce belong to this run.
It never kills by process name. Drive closes the browser and its contexts in a
`finally` block, including on failure. Cleanup retires scratch under the run's
`_to_delete/` directory without deleting files. Evidence stays in `evidence/`.
Require the second evidence check to pass after teardown; this is the generated
skill's completion check. A failed iteration gets the same cleanup and evidence check.

## Helpers

`verify-doctorcre.mjs` is the executable CLI. Its commands are `launch`, `doctor`,
`drive <feature-id|all>`, `evidence`, and `cleanup`; every command accepts `--run`.
Only `launch` accepts `--root`. The commands above are the supported invocation.
`recipes.mjs` contains its app-specific Playwright recipes and is loaded by the CLI.

Use `/maintain-verification-skill` to keep this skill and its map aligned with
app changes. That pass reads source and drives every mapped feature before
shipping corrections; product defects remain findings rather than doc rewrites.
