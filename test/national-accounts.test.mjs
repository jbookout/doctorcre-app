import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { renderAccountCards } from '../js/account-cards.js';

const helpers = {
  esc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  relative: () => 'not captured',
  actorName: (value) => value === 'dell' ? 'Dell' : 'Joe',
};

test('account boot leaves theme to <html> and never toggles a body theme class', async () => {
  // V2 S1: theme-boot.js sets data-theme and data-color-assist on <html> before
  // paint; the page reads them through css/tokens.css. The old boot block set
  // body.night and reached for a #colorAssistButton that no longer exists.
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const boot = app.match(/async function boot\(\) \{([\s\S]*?)\n\}/)[1];
  assert.doesNotMatch(boot, /classList\.(add|toggle)\(['"](night|color-assist)['"]/);
  assert.doesNotMatch(app, /#colorAssistButton/);
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /body\.(night|color-assist)/, 'app.css reads theme from <html>, not body aliases');
  assert.match(css, /:root\[data-color-assist="on"\]/);
  assert.match(app, /renderAccountCards\(state.accounts/);
});

const portfolioFixture = {
  account_client_id: 'demo-care-network', account_client_ref: 'D-907', account_name: 'Demo Care Network',
  account_owner: 'dell', open_deals: 7, attention_deals: 0,
  stale_deals: 3, parked_deals: 0, last_review_at: null,
};

test('portfolio fixtures identify synthetic accounts', () => {
  assert.match(portfolioFixture.account_name, /^Demo /);
  assert.match(portfolioFixture.account_client_id, /^demo-/);
  assert.match(portfolioFixture.account_client_ref, /^D-/);
});

test('the portfolio surface renders only accounts supplied by the CARR read', () => {
  const html = renderAccountCards([portfolioFixture], helpers);
  assert.equal((html.match(/class="account-card"/g) || []).length, 1);
  assert.match(html, /Demo Care Network/);
  assert.doesNotMatch(html, /Demo Dental Group|Demo Therapy Network/);
  assert.match(html, /<svg[^>]*role="img"/);
  assert.match(html, /<path\b/);
  assert.match(html, /Market deals/);
  assert.match(html, />7</);
  assert.match(html, /data-pulse="attention"/);
});

test('an account without a sub-client count uses one neutral structure node', () => {
  for (const open_deals of [0, 1, 7]) {
    const html = renderAccountCards([{
      account_client_id: 'demo-unmeasured', account_name: 'Demo Unmeasured', open_deals,
    }], helpers);
    assert.equal((html.match(/class="flow-child"/g) || []).length, 1);
    assert.match(html, /<rect class="flow-child"/);
    const label = html.match(/<svg[^>]*aria-label="([^"]*)"/)[1];
    assert.match(label, /through sub-clients/);
    assert.doesNotMatch(label, /(?:\d+|two) sub-clients/);
    assert.match(label, new RegExp(`${open_deals} active market deals`));
  }
});

test('account captions stay at least 11px and diagram captions do not scale with the SVG', async () => {
  const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../css/tokens.css', import.meta.url), 'utf8');
  // Sizes are written as px or as a type token; a token resolves through css/tokens.css.
  const px = (value) => {
    const token = value.match(/^var\((--font-size-\d)\)$/);
    if (!token) return Number(value.match(/^([\d.]+)px$/)?.[1]);
    const [, amount, unit] = tokens.match(new RegExp(`${token[1]}:\\s*([\\d.]+)(px|rem)`)) || [];
    return Number(amount) * (unit === 'rem' ? 16 : 1);
  };
  const sizesIn = (rules) => rules.flatMap(([, body]) => [...body.matchAll(/font-size:\s*([^;]+?)\s*(?:;|$)/g)].map((match) => px(match[1])));
  const metricRules = [...css.matchAll(/\.account-metrics span\s*\{([^}]*)\}/g)];
  const sizes = sizesIn(metricRules);
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((size) => size >= 11), `metric font sizes: ${sizes}`);
  const html = renderAccountCards([portfolioFixture], helpers);
  assert.doesNotMatch(html.match(/<svg[\s\S]*?<\/svg>/)[0], /class="flow-label"/);
  assert.match(html, /class="account-flow-labels"[^>]*><span>Account<\/span><span>Sub-clients<\/span><span>Market deals<\/span>/);
  const captionRules = [...css.matchAll(/\.account-flow-labels\s*\{([^}]*)\}/g)];
  const captionSizes = sizesIn(captionRules);
  assert.ok(captionSizes.length > 0 && captionSizes.every((size) => size >= 11));
});

test('portfolio motion rate follows urgency without hiding the still-state labels', () => {
  const account = { account_client_id: 'a', account_name: 'Account', open_deals: 1 };
  assert.match(renderAccountCards([{ ...account, overdue_deals: 1 }], helpers), /data-pulse="overdue"/);
  assert.match(renderAccountCards([{ ...account, attention_deals: 1 }], helpers), /data-pulse="attention"/);
  assert.match(renderAccountCards([{ ...account }], helpers), /data-pulse="healthy"/);
  assert.match(renderAccountCards([{ ...account, open_deals: 0 }], helpers), /data-pulse="dormant"/);
});

test('an overdue-only account exposes its count in visible text and the accessible diagram', () => {
  for (const overdue_deals of [0, 1, 3]) {
    const html = renderAccountCards([{
      account_client_id: 'demo-due', account_name: 'Demo Due', open_deals: 3,
      attention_deals: 0, stale_deals: 0, overdue_deals,
    }], helpers);
    const document = new JSDOM(html).window.document;
    const metrics = [...document.querySelectorAll('.account-metrics > div')];
    const overdue = metrics.find((metric) => metric.querySelector('span').textContent === 'Overdue');
    assert.ok(overdue, 'Overdue must have a visible metric independent of attention');
    assert.equal(overdue.querySelector('b').textContent, String(overdue_deals));
    assert.equal(overdue.closest('[aria-hidden="true"], [hidden]'), null);
    assert.match(document.querySelector('svg').getAttribute('aria-label'), new RegExp(`${overdue_deals} overdue`));
    assert.match(metrics.find((metric) => metric.querySelector('span').textContent === 'Attention').textContent, /^0/);
  }
});

test('account names and references cannot inject markup into the diagram or card', () => {
  const html = renderAccountCards([{
    account_client_id: 'unsafe" onclick="alert(1)', account_client_ref: '<script>',
    account_name: '<img src=x>', account_owner: 'joe', open_deals: 0,
  }], helpers);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;img src=x>/);
  assert.match(html, /data-account="unsafe&quot; onclick=&quot;alert\(1\)"/);
});
