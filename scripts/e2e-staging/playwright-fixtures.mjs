import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base } from 'playwright/test';

import { SweepFailure } from './controls.mjs';
import { installStagingGuard } from './engine.mjs';
import { targets } from './screens.mjs';
import { stagingRelease, stagingSession, STAGING_ORIGIN } from './session.mjs';

const sameRelease = (left, right) => left?.source_commit === right?.source_commit && left?.carr_source_commit === right?.carr_source_commit;

export function createFreshPageFactory({ browser, origin = STAGING_ORIGIN, installGuard = installStagingGuard, releaseProbe }) {
  const contexts = new Set();
  const freshPage = async ({ screen, release }) => {
    let context, phase = 'session-preflight', code = 'session-preflight-failed';
    try {
      if (!sameRelease(await releaseProbe(), release)) throw new SweepFailure('session-preflight', 'source-pair-changed');
      phase = 'context'; code = 'context-creation-failed';
      context = await browser.newContext();
      contexts.add(context);
      context.on?.('close', () => contexts.delete(context));
      code = 'guard-install-failed';
      await installGuard(context);
      code = 'page-creation-failed';
      const page = await context.newPage();
      phase = 'navigation'; code = 'navigation-failed';
      const response = await page.goto(new URL(screen.path, origin).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!response?.ok() || page.url().includes('/auth/') || new URL(page.url()).origin !== origin) throw new SweepFailure('navigation', 'screen-response-refused');
      phase = 'load'; code = 'network-idle-failed';
      await page.waitForLoadState('networkidle', { timeout: 30_000 });
      return page;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      throw error instanceof SweepFailure ? error : new SweepFailure(phase, code);
    }
  };
  return {
    freshPage,
    async dispose() { await Promise.all([...contexts].map(context => context.close().catch(() => {}))); },
  };
}

const attachmentTypes = Object.freeze([
  ['controls.json', 'staging-controls', 'application/json'],
  ['coverage.md', 'staging-coverage', 'text/markdown'],
  ['findings.json', 'staging-findings', 'application/json'],
  ['sweep-verdict.json', 'staging-verdict', 'application/json'],
]);

export async function attachSweepArtifacts(testInfo, output) {
  for (const [file, name, contentType] of attachmentTypes) {
    const path = join(output, file);
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await testInfo.attach(name, { path, contentType });
  }
}

export const test = base.extend({
  stagingTarget: async ({}, use, testInfo) => {
    const target = targets.find(row => row.name === testInfo.project.metadata.stagingTarget);
    if (!target) throw new Error('Playwright staging project does not name a registered target');
    await use(target);
  },
  freshPage: async ({ browser, request }, use) => {
    const fixture = createFreshPageFactory({ browser, releaseProbe: () => stagingRelease(request) });
    try { await use(fixture.freshPage); }
    finally { await fixture.dispose(); }
  },
  stagingSession: async ({ request }, use) => {
    await use(origin => stagingSession(origin, { requestContext: request, exchange: false }));
  },
});
