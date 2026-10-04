import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { renderAccountCards } from '../js/account-cards.js';

const helpers = { esc: String, relative: () => 'not captured', actorName: () => 'Demo owner' };
const accounts = [
  { account_client_id: 'demo-healthy', account_name: 'Demo Healthy', open_deals: 1 },
  { account_client_id: 'demo-attention', account_name: 'Demo Attention', open_deals: 1, attention_deals: 1 },
  { account_client_id: 'demo-overdue', account_name: 'Demo Overdue', open_deals: 1, overdue_deals: 1 },
  { account_client_id: 'demo-dormant', account_name: 'Demo Dormant', open_deals: 0 },
];

test('reduced motion stops both portfolio animations across every urgency state', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
    await page.setContent(`<style>${css}</style><div class="account-grid">${renderAccountCards(accounts, helpers)}</div>`);
    const readMotion = () => page.locator('.account-card').evaluateAll((cards) => cards.map((card) => ({
      pulse: card.dataset.pulse,
      elements: [...card.querySelectorAll('.flow-link, .flow-deals')].map((element) => ({
        name: getComputedStyle(element).animationName,
        animations: element.getAnimations().length,
      })),
    })));
    for (const reducedMotion of ['no-preference', 'reduce', 'no-preference']) {
      await page.emulateMedia({ reducedMotion });
      const states = await readMotion();
      assert.deepEqual(states.map(({ pulse }) => pulse), ['healthy', 'attention', 'overdue', 'dormant']);
      const failures = states.flatMap(({ pulse, elements }) => elements.flatMap((element, index) => {
        const stopped = reducedMotion === 'reduce' || pulse === 'dormant';
        const expectedName = stopped ? 'none' : index === 0 ? 'account-flow' : 'account-breathe';
        return element.name === expectedName && element.animations === (stopped ? 0 : 1)
          ? [] : [{ reducedMotion, pulse, element: index, expectedName, ...element }];
      }));
      assert.deepEqual(failures, []);
    }
  } finally {
    await browser.close();
  }
});

test('overdue-only status stays visible and accessible in the phone and desktop still state', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
    await page.setContent(`<style>${css}</style><body class="night"><main class="shell"><div class="account-grid">${renderAccountCards([accounts[2]], helpers)}</div></main></body>`);
    for (const width of [320, 390, 680, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.getByRole('img', { name: /Demo Overdue:.*1 overdue/ }).count(), 1);
      assert.equal(await page.getByText('Overdue', { exact: true }).isVisible(), true);
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        card: document.querySelector('.account-card').scrollWidth,
        cardWidth: document.querySelector('.account-card').clientWidth,
        sizes: [...document.querySelectorAll('.account-metrics span, .account-flow-labels span')]
          .map((caption) => parseFloat(getComputedStyle(caption).fontSize)),
        overdue: [...document.querySelectorAll('.account-metrics > div')]
          .find((metric) => metric.textContent.includes('Overdue')).textContent.trim(),
      }));
      assert.ok(layout.document <= layout.viewport, `${width}px document overflow`);
      assert.ok(layout.card <= layout.cardWidth, `${width}px card overflow`);
      assert.ok(layout.sizes.every((size) => size >= 11), `${width}px caption size`);
      assert.equal(layout.overdue, '1Overdue');
    }
  } finally {
    await browser.close();
  }
});
