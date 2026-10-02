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

test('merged account boot honors saved light and defaults to dark', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const themeInit = app.match(/async function boot\(\) \{([\s\S]*?)  if \(localStorage.getItem\('dealroom-color-assist'\)/)[1];
  for (const saved of [null, 'night', 'light']) {
    for (const initialDark of [false, true]) {
      const classes = new Set(initialDark ? ['night'] : []);
      vm.runInNewContext(themeInit, {
        localStorage: { getItem: () => saved },
        document: { body: { classList: {
          add: (name) => classes.add(name),
          toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        } } },
      });
      assert.equal(classes.has('night'), saved !== 'light');
    }
  }
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
  const metricRules = [...css.matchAll(/\.account-metrics span\s*\{([^}]*)\}/g)];
  const sizes = metricRules.flatMap(([, body]) => [...body.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1])));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((size) => size >= 11), `metric font sizes: ${sizes}`);
  const html = renderAccountCards([portfolioFixture], helpers);
  assert.doesNotMatch(html.match(/<svg[\s\S]*?<\/svg>/)[0], /class="flow-label"/);
  assert.match(html, /class="account-flow-labels"[^>]*><span>Account<\/span><span>Sub-clients<\/span><span>Market deals<\/span>/);
  const captionRules = [...css.matchAll(/\.account-flow-labels\s*\{([^}]*)\}/g)];
  const captionSizes = captionRules.flatMap(([, body]) => [...body.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1])));
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
