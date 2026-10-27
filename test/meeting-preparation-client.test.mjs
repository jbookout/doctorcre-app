import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../js/fixture-client.js';
import { createLiveClient } from '../js/live-client.js';

const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}`;

test('meeting preparation uses the authenticated no-argument read and forwards cancellation', async () => {
  const requests = [];
  const controller = new AbortController();
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    requests.push(JSON.parse(init.body).params);
    assert.equal(init.signal.aborted, false);
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify({ state: 'empty', items: [] }) }] } });
  } });
  assert.deepEqual(await client.calendarMeetingPrep({ signal: controller.signal }), { state: 'empty', items: [] });
  assert.deepEqual(requests, [{ name: 'calendar-meeting-prep', arguments: {} }]);
  controller.abort();
  await assert.rejects(client.calendarMeetingPrep({ signal: controller.signal }));
});

test("synthetic Home provides a calendar entry and preparation uses only the authenticated partner's open deals", async () => {
  for (const selfActor of ['joe', 'dell']) {
    const client = await createFixtureClient({ seedUrl, selfActor });
    const board = await client.getBoard();
    const prep = await client.calendarMeetingPrep();
    const calendar = (await client.morningBrief()).sections.calendar;
    assert.equal(calendar.items[0].title, 'Demo practice planning');
    assert.equal(prep.items[0].title, 'Demo practice planning');
    assert.ok(Date.parse(prep.items[0].end) > Date.parse(prep.items[0].start));
    for (const match of prep.items[0].possible_deals) {
      const deal = board.deals.find(row => row.id === match.id);
      assert.equal(deal.owner, selfActor);
      assert.ok(!deal.outcome);
      assert.equal(match.prep.next_step, deal.next_step);
    }
  }
});
