import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'), 'src/ui/reply-device-drafts.ts');
const { createReplyDeviceDrafts } = await import(`data:text/javascript;base64,${bundle.toString('base64')}`);
const row = { id: 'proposal-1', version: 3, reply_draft: { subject: 'Original', body: 'Original body', to: ['a@example.test'], cc: ['b@example.test'] } };
const edited = { baseVersion: 3, subject: '  half', body: '', to: ['a@example.test'], cc: ['b@example.test'] };
function memory() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
test('partial text survives reopening only for its partner and proposal', () => {
  const storage = memory();
  assert.equal(createReplyDeviceDrafts(storage, 'joe').save(row.id, edited), true);
  assert.deepEqual(createReplyDeviceDrafts(storage, 'joe').restore(row), { ...edited, conflict: false });
  assert.equal(createReplyDeviceDrafts(storage, 'dell').restore(row), null);
  assert.equal(createReplyDeviceDrafts(storage, '').restore(row), null);
  assert.equal(createReplyDeviceDrafts(storage, 'joe').restore({ ...row, id: 'other' }), null);
});
test('version and recipient changes preserve text and require explicit review', () => {
  const drafts = createReplyDeviceDrafts(memory(), 'joe'); drafts.save(row.id, edited);
  for (const changed of [{ ...row, version: 4 }, { ...row, reply_draft: { ...row.reply_draft, to: ['other@example.test'] } }]) {
    assert.deepEqual(drafts.restore(changed), { ...edited, conflict: true });
  }
  drafts.remove(row.id);
  assert.equal(drafts.restore(row), null);
});
test('corrupt or unavailable storage never claims device persistence', () => {
  const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('denied'); } };
  assert.equal(createReplyDeviceDrafts(broken, 'joe').restore(row), null);
  assert.equal(createReplyDeviceDrafts(broken, 'joe').save(row.id, edited), false);
  const storage = memory(); storage.setItem('doctorcre:reply-device:v1:joe:proposal-1', '{bad');
  assert.equal(createReplyDeviceDrafts(storage, 'joe').restore(row), null);
});
test('late save confirmation cannot erase newer typing from another tab', () => {
  const storage = memory(), drafts = createReplyDeviceDrafts(storage, 'joe');
  drafts.save(row.id, edited);
  createReplyDeviceDrafts(storage, 'joe').save(row.id, { ...edited, body: 'Newer typing' });
  drafts.remove(row.id, edited);
  assert.equal(drafts.restore(row).body, 'Newer typing');
  drafts.remove(row.id, { ...edited, body: 'Newer typing' });
  assert.equal(drafts.restore(row), null);
});
