import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageBudget, MAX_READ_PAGES } from '../js/read-budget.mjs';

test('a paginated read stops at its hard page cap even if every cursor advances', () => {
  const takePage = createPageBudget();
  assert.equal(MAX_READ_PAGES, 100);
  for (let page = 0; page < 100; page++) takePage();
  assert.throws(takePage, /page_limit/);
});

test('a page budget stops before another read when hidden or past its deadline', () => {
  const document = { visibilityState: 'visible' }; let time = 0;
  const takePage = createPageBudget({ document, now: () => time });
  takePage(); document.visibilityState = 'hidden';
  assert.throws(takePage, /read_paused/);
  document.visibilityState = 'visible'; time = 30 * 60_000;
  assert.throws(takePage, /read_paused/);
});
