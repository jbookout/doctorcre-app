import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();

test('regression fixtures keep recorder state idle during refused app reads', { requires: ['browser'] }, async ({ app, browser }) => {
  await refuseReads(app, browser);
  await app.open('/');
  expect(await browser.evaluate(async () => (await fetch('/api/auth/session')).status)).toBe(503);
  const recorder = await browser.evaluate(async () => {
    const response = await fetch('http://127.0.0.1:4682/api/state');
    return { status: response.status, state: await response.json() };
  });
  expect(recorder).toEqual({ status: 200, state: { state: 'idle' } });
});
