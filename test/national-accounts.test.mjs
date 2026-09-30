import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
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

test('the portfolio surface renders only accounts supplied by the CARR read', () => {
  const html = renderAccountCards([{
    account_client_id: 'musicologie', account_client_ref: 'C-161', account_name: 'Musicologie',
    account_owner: 'dell', open_deals: 15, attention_deals: 0,
    stale_deals: 15, parked_deals: 0, last_review_at: null,
  }], helpers);
  assert.equal((html.match(/class="account-card"/g) || []).length, 1);
  assert.match(html, /Musicologie/);
  assert.doesNotMatch(html, /Operation Dental|Kain Capital/);
  assert.match(html, /<svg[^>]*role="img"/);
  assert.match(html, /<path\b/);
  assert.match(html, /Market deals/);
  assert.match(html, />15</);
  assert.match(html, /data-pulse="attention"/);
});

test('portfolio motion rate follows urgency without hiding the still-state labels', () => {
  const account = { account_client_id: 'a', account_name: 'Account', open_deals: 1 };
  assert.match(renderAccountCards([{ ...account, overdue_deals: 1 }], helpers), /data-pulse="overdue"/);
  assert.match(renderAccountCards([{ ...account, attention_deals: 1 }], helpers), /data-pulse="attention"/);
  assert.match(renderAccountCards([{ ...account }], helpers), /data-pulse="healthy"/);
  assert.match(renderAccountCards([{ ...account, open_deals: 0 }], helpers), /data-pulse="dormant"/);
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
