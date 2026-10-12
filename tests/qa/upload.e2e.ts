import { expect } from 'e2e';
import { test } from './support.ts';

const file='tests/qa/fixtures/tour-packet.synthetic.txt';
const name='tour-packet.synthetic.txt';

test('Tours native synthetic text upload stays in its private draft and can be removed', {session:'joe'}, async ({app,browser}) => {
  await app.open('/tours?mode=fixture');
  await expect(browser.locator('#packet-upload')).toHaveCount(1);
  await browser.locator('#packet-upload').setInputFiles(file);
  await expect(browser.locator('#file-count')).toHaveText('1 files');
  await expect(browser.locator('#packet-files')).toContainText(name);
  await expect(browser.locator('#file-message')).toHaveText('');
  await browser.locator('#packet-files').scrollIntoView();
  await app.screenshot('synthetic-text-attached');

  await browser.locator(`#packet-files button[aria-label="Remove ${name}"]`).tap();
  await expect(browser.locator('#file-count')).toHaveText('0 files');
  await browser.locator('#packet-upload').setInputFiles(file);
  await expect(browser.locator('#file-count')).toHaveText('1 files');
  await app.open('/tours?mode=fixture');
  await expect(browser.locator('#file-count')).toHaveText('0 files');
  await browser.locator('#packet-drop').scrollIntoView();
  await app.screenshot('private-attachment-cleared-after-navigation');
});
