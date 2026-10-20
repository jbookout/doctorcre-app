import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderAccountCards } from '../../js/account-cards.js';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.abort());
});

const helpers = { esc: String, relative: () => 'not captured', actorName: () => 'Demo owner' };
const accounts = [
  { account_client_id: 'demo-healthy', account_name: 'Demo Healthy', open_deals: 1 },
  { account_client_id: 'demo-attention', account_name: 'Demo Attention', open_deals: 1, attention_deals: 1 },
  { account_client_id: 'demo-overdue', account_name: 'Demo Overdue', open_deals: 1, overdue_deals: 1 },
  { account_client_id: 'demo-dormant', account_name: 'Demo Dormant', open_deals: 0 },
];

const styles = async () => {
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../css/app.css', import.meta.url), 'utf8');
  return `<style>${tokens}</style><style>${css}</style>`;
};

test('portfolio metrics stay still and preserve every urgency state and motion preference', async ({ page }) => {
  await page.setContent(`${await styles()}<div class="account-grid">${renderAccountCards(accounts, helpers)}</div>`);
  const readMotion = () => page.locator('.account-card').evaluateAll((cards) => cards.map((card) => ({
    pulse: card.dataset.pulse,
    metrics: [...card.querySelectorAll('.account-metrics > div')].map(metric => metric.textContent.trim()),
    elements: [card, ...card.querySelectorAll('.account-metrics *, .account-flow-labels')].map((element) => ({
      name: getComputedStyle(element).animationName,
      animations: element.getAnimations().length,
    })),
  })));
  for (const reducedMotion of ['no-preference', 'reduce', 'no-preference']) {
    await page.emulateMedia({ reducedMotion });
    const states = await readMotion();
    assert.deepEqual(states.map(({ pulse }) => pulse), ['healthy', 'attention', 'overdue', 'dormant']);
    const moving = states.flatMap(({ pulse, elements }) => elements
      .filter((element) => element.name !== 'none' || element.animations !== 0)
      .map((element) => ({ reducedMotion, pulse, ...element })));
    assert.deepEqual(moving, []);
    assert.ok(states[0].metrics.includes('0Attention'));
    assert.ok(states[1].metrics.includes('1Attention'));
    assert.ok(states[2].metrics.includes('1Overdue'));
    assert.ok(states[3].metrics.includes('0Active work'));
  }
});

test('overdue-only status stays visible and accessible in the phone and desktop still state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`${await styles()}<main class="shell"><div class="account-grid">${renderAccountCards([accounts[2]], helpers)}</div></main>`);
  for (const width of [320, 390, 680, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.getByRole('button', { name: /Demo Overdue/ }).count(), 1);
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
    assert.ok(layout.sizes.every((size) => size >= 13), `${width}px caption size`);
    assert.equal(layout.overdue, '1Overdue');
  }
});
