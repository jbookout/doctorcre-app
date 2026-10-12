import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-031 Design Lab renders distinct orange and cyan token swatches', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/design-lab');
  await expect(screen.getByRole('tab', 'Tokens', { exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(browser.locator('.swatch-grid .token')).toHaveCount(12);
  const colors = await browser.evaluate(() => {
    const tokens = ['--orange', '--cyan'];
    const root = getComputedStyle(document.documentElement);
    const expected = tokens.map(token => {
      const hex = root.getPropertyValue(token).trim().replace('#', '');
      return `rgb(${[0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
    });
    const observed = tokens.map(token => {
      const swatch = [...document.querySelectorAll('.swatch-grid .token')].find(row => row.querySelector('b')?.textContent === token)?.querySelector('span');
      return swatch ? getComputedStyle(swatch).backgroundColor : null;
    });
    return { expected, observed };
  });
  console.log('Labeled token swatch colors:', colors);
  await app.screenshot('qa-031-worker-token-swatches');
  expect(colors.observed).toEqual(colors.expected);
});
