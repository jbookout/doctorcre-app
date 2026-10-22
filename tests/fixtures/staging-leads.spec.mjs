import { test } from '@playwright/test';
import { routeLeads } from '../../test/leads-browser-fixture.mjs';
import { workspace } from '../../test/leads-workspace-fixture.mjs';
import { readFile } from 'node:fs/promises';

test.use({ baseURL: 'http://localhost' });
test.beforeEach(async ({ page }) => {
  const board = workspace();
  board.leads[0].owner = 'joe';
  await routeLeads(page, { getBoard: () => board });
  // Staging c7601e8 retains PR #134's sidebar slot; PR #303 moved it into main.
  const html = await readFile(new URL('../../leads.html', import.meta.url), 'utf8');
  await page.route('http://localhost/leads', route => route.fulfill({
    contentType: 'text/html', body: html.replace('<section class="controls', '<section data-layout-slot="sidebar" class="controls'),
  }));
});

// Run the staging assertions themselves against the real shell and synthetic HTTP adapter.
import '../staging/leads.spec.ts';
