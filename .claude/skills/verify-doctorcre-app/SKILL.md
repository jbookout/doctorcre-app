---
name: verify-doctorcre-app
description: Drive the real DoctorCRE web app with its existing Playwright helpers to prove a UI change, capture evidence, and clean up local fixtures or signed-in staging.
---

# Verify DoctorCRE app

Read [the feature index](features/README.md), then the matching feature recipe. Prove the changed entry points, not only a convenient route. This skill verifies the web UI. Unit tests and contract checks remain separate.

## Launch

Use an isolated doctorcre-app checkout. Run `npm ci`, then `npm run check`. The lockfile requires Node `^22.22.3 || >=24.8.0`. If Chromium is unavailable, run `npx playwright install chromium`. The existing browser helper documents the WebKit crash on macOS 27 or later.

Choose one target.

- **Local fixtures.** `PORT=0 npm run serve` starts `scripts/serve.mjs` on a free loopback port. It prints `DoctorCRE fixture server: http://127.0.0.1:<assigned-port>`. Synthetic repository data needs no credentials, migrations or database. The proof below uses `fixtureServer()` from `test/browser-harness.mjs`, which starts that same server and owns teardown. Each run gets its own port, browser context and storage. Readiness means rendered deal controls, not only a log line. Do not use `?mode=live` locally.
- **Signed-in staging.** `playwright.config.ts` targets `https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev`. Check presence only with `node -e 'console.log(Boolean(process.env.E2E_SESSION_SECRET))'`. Never search for, print or open the secret or generated session file. If absent, use local fixtures and report the staging gaps in Evidence. If present, use a fresh isolated checkout with no existing `playwright/.auth/staging.json`. Run `npx playwright test --project=chromium tests/staging/deals.spec.ts --grep '^Local Deals switches board and list views and inspects a deal$' --output=.e2e/verify-staging --trace=on`. Its setup dependency runs `tests/staging/auth.setup.ts`, checks `e2e-joe`, and writes ignored browser state. This selected journey only reads deals and changes presentation. Other staging specs create or change records. Never reset shared staging data or run mutation specs without an authorized synthetic target.

For a complete local smoke proof, copy the JavaScript in Drive to `.e2e/verify-deals.test.mjs`. All these commands are required from the repository root.

```sh
mkdir -p .e2e
export VERIFY_EVIDENCE_DIR="$(mktemp -d /tmp/doctorcre-verify.XXXXXX)"
node --test .e2e/verify-deals.test.mjs > "$VERIFY_EVIDENCE_DIR/run.log" 2>&1
cat "$VERIFY_EVIDENCE_DIR/cleanup.json"
```

Retain the absolute evidence path. The temporary test belongs in this checkout's ignored `.e2e/` directory so its relative imports resolve.

## Doctor

The local recipe performs one read-only doctor before driving. It checks the owned server's `/app-release` identity and contract version, compares its pipeline module with this checkout, then waits for usable deal controls. Fixture release SHAs are forty zeroes, not deployment proof. The report separately records the checkout revision and served module digest.

For staging, the setup checks `/auth/session`, the expected principal and actor. Run `npx playwright test --project=chromium tests/staging/signed-in.spec.ts --grep 'navigates to Local Deals' --output=.e2e/verify-staging-identity --trace=on` to verify session reuse after reload. Read `/app-release` and compare `source_commit` with the revision being verified before attributing staging behavior to a change. A sign-in redirect, unavailable board or wrong revision fails doctor. Do not replace staging reads with fixture routing.

## Drive

Use `test/browser-harness.mjs` for local Playwright runs. It blocks external browser requests and owns browser teardown through Node's test lifecycle. Use ARIA names and stable handles from the map. The existing `tests/staging/journey-flows.mjs` covers lease and tour journeys if later work reaches them; its staging producer has additional prerequisites in `journey-fixture.mjs`.

Copy this exact Deals recipe to `.e2e/verify-deals.test.mjs`. Change the user actions only when verifying a different mapped feature.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { chromium, fixtureServer } from '../test/browser-harness.mjs';

test('Deals: launch, doctor, room journey, evidence and cleanup', async () => {
  const evidence = process.env.VERIFY_EVIDENCE_DIR
    ? resolve(process.env.VERIFY_EVIDENCE_DIR)
    : await mkdtemp(join(tmpdir(), 'doctorcre-verify-'));
  await mkdir(evidence, { recursive: true });
  console.log(`Evidence: ${evidence}`);
  const report = { feature: 'deals', target: 'local-fixture',
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    steps: [], requests: [], pageErrors: [] };
  const save = (name, value) => writeFile(join(evidence, name), value);
  const server = await fixtureServer();
  let browser, page, passed = false;
  try {
    const release = await (await fetch(server.origin + '/app-release')).json();
    const contract = JSON.parse(await readFile('contracts/carr-interface.v1.json', 'utf8'));
    assert.equal(release.service, 'doctorcre-app');
    assert.equal(release.environment, 'fixture');
    assert.equal(release.carr_contract.version, contract.version);
    const served = await (await fetch(server.origin + '/js/pipeline.js')).text();
    assert.equal(served, await readFile('js/pipeline.js', 'utf8'));
    report.moduleSha256 = createHash('sha256').update(served).digest('hex');
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    await page.route(url => url.origin !== server.origin, route => route.abort());
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => report.requests.push({ method: request.method(),
      origin: new URL(request.url()).origin, path: new URL(request.url()).pathname }));
    const otherResponses = [];
    page.on('response', response => {
      if (new URL(response.url()).origin !== server.origin) otherResponses.push(response.url());
    });
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), button => button.click());
    await page.goto(server.origin + '/deals');
    await expect(page.locator('#pageTitle')).toHaveText('Local Deals');
    await expect(page.locator('.card-open').first()).toBeVisible();
    report.steps.push('doctor: owned fixture identity, matching module and usable deals');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.locator('#listView')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.locator('#boardView')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: join(evidence, 'deals-board.png'), fullPage: true });
    await save('deals-board.aria.txt', await page.locator('body').ariaSnapshot());
    const entry = page.locator('.card-open').first();
    const selected = (await entry.innerText()).trim();
    assert.ok(selected);
    await entry.click();
    await expect(page.locator('#recordPanel')).toBeVisible();
    await expect(page.locator('#panelTitle')).toHaveText(selected);
    await expect(page.locator('#detailUpdateForm')).toBeVisible();
    await page.screenshot({ path: join(evidence, 'deal-room.png'), fullPage: true });
    await save('deal-room.aria.txt', await page.locator('body').ariaSnapshot());
    report.steps.push('deals-board-open: selected card opens the matching room',
      'deals-views: list and board controls respond');
    await page.getByRole('button', { name: 'Close deal', exact: true }).click();
    await expect(page.locator('#recordPanel')).toBeHidden();
    await entry.click();
    await expect(page.locator('#panelTitle')).toHaveText(selected);
    report.steps.push('deals-reopen: same card reopens the same room');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(otherResponses, []);
    assert.equal(report.requests.some(request => !['GET', 'HEAD'].includes(request.method)), false);
    report.steps.push('side effects: no browser write requests observed; fixture state discarded on close');
    passed = true;
  } finally {
    try {
      if (page) await page.context().tracing.stop({ path: join(evidence, 'trace.zip') });
    } finally {
      try { await browser?.close(); } finally { await server.close(); }
      await assert.rejects(fetch(server.origin + '/app-release', { signal: AbortSignal.timeout(1000) }));
      report.serverStopped = true;
      report.passed = passed;
      await save('report.json', JSON.stringify(report, null, 2) + '\n');
    }
  }
  for (const name of ['deals-board.png', 'deal-room.png', 'trace.zip', 'report.json']) {
    assert.ok((await stat(join(evidence, name))).size > 0, `${name} survives cleanup`);
  }
  await save('cleanup.json', JSON.stringify({ serverStopped: true, evidenceSurvived: true }) + '\n');
});
```

This smoke run covers the Board entry and view toggles. The map also lists Home and direct-link entries. Report them separately until driven.

## Evidence

Keep `VERIFY_EVIDENCE_DIR` outside a retiring checkout. The recipe writes two screenshots, two ARIA snapshots, a Playwright trace, action steps, request metadata, page errors and a cleanup receipt. `run.log` holds stdout, stderr and Node's test result. Inspect both images with the session's image viewer before claiming visual proof. Diagnose failures with `npx playwright show-trace "$VERIFY_EVIDENCE_DIR/trace.zip"`.

Exercise user controls, not internal setters, injected app state or test-only write endpoints. Capture actions and results in the trace and steps. For a write, reopen the record through a separate user-facing read and verify its value and sibling records. A success toast alone is insufficient. Use the existing fixture adapter only at its supported client seam. Fixture persistence does not prove remote persistence.

Observe the safe mode. The recipe blocks every browser origin except its owned fixture server, including other loopback services, and asserts that none answers. It records attempted methods and paths and fails on browser write requests. Fixtures may attempt blocked fonts or Quill state reads, or receive 404s from unused API reads. This proof does not call MCP writes, touch production, create business records or use host audio. For a mutation journey, replace the read-only assertion only after choosing an authorized synthetic target and a concrete readback and cleanup plan.

Without `E2E_SESSION_SECRET`, report these staging steps as **unverified**: `/auth/e2e-session` issuance; `e2e-joe` identity and cookie reuse after reload; deployed release revision; live board and matching room reads; staging screenshots and trace; remote write/readback and fixture cleanup. Local replaces edge hosting with `scripts/serve.mjs`, authentication with the fixture client, and CARR reads with synthetic seed data. No database provisioning, provider deployment or remote migration ran. Do not call those setup steps verified by a local run.

Staging artifacts may contain private data. Keep them outside public commits and PR uploads. Publish only reviewed synthetic evidence. Omit auth files, headers, cookies and raw request bodies from reports.

## Cleanup

The recipe closes only its own browser contexts and server in `finally`, including failed iterations. Node's existing test hook closes pooled Chromium at test exit. Never kill by process name or stop a listener you did not launch. A failed run without `report.json` showing `serverStopped` needs cleanup investigation before retrying.

Remove only `.e2e/verify-deals.test.mjs` after the run. Preserve the evidence directory. Require nonempty artifacts and `cleanup.json` with `evidenceSurvived: true` before reporting success.

For staging, Playwright closes its browser. Copy `.e2e/verify-staging` and `.e2e/verify-staging-identity` into the external evidence directory before retiring the checkout. Add before/after screenshots with `page.screenshot()` to a run-owned copy of the selected spec when proving a changed UI, and retain them with its trace. Reuse the existing Playwright configuration and setup dependency. Remove that temporary spec afterward. In the fresh checkout that created it, remove only `playwright/.auth/staging.json` without opening it. The selected Deals read journey creates no business records.

## Helpers

No new launcher or browser harness ships here. The recipe invokes the existing `fixtureServer()` and `chromium.launch()`. Run the disposable recipe with `node --test`, not plain `node`, so browser cleanup runs. The existing Playwright setup dependency invokes `auth.setup.ts`. The vision runner in `e2e.config.ts` is optional and needs separate model configuration; this deterministic proof does not need it.

Use `/pstack:maintain-verification-skill` in Claude Code, or `/maintain-verification-skill` where registered, to keep the map aligned with app changes.
