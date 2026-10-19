import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoopFixture } from '../tests/staging/loop-fixture.ts';

for (const kind of ['team_loop', 'idea', 'open_loop']) {
  test(`staging ${kind} fixture closes its loop using the read-loop envelope`, async () => {
    const calls = [];
    let loop;
    const request = {
      async post(_url, { data }) {
        const { name, arguments: args } = data.params;
        calls.push(name);
        let value;
        if (name === 'add-loop') {
          assert.equal(args.kind, kind);
          loop = { loop_id: 'synthetic-loop', title: args.title, status: 'open', version: 7 };
          value = { ok: true, loop_id: loop.loop_id };
        } else if (name === 'read-loop') {
          assert.equal(args.loop_id, loop.loop_id);
          // carr-system baaa639a14f4628cddc1ded34c9bd73296db50ce,
          // mcp-server/src/tools.js read-loop and withAmendmentHistory.
          value = { loop: { ...loop }, amended: false, amendments: [] };
        } else if (name === 'close-loop') {
          assert.equal(args.loop_id, loop.loop_id);
          assert.equal(args.base_version, 7);
          assert.equal(args.resolution, 'done');
          assert.equal(typeof args.idempotency_key, 'string');
          loop = { ...loop, status: 'done', version: 8 };
          value = { ok: true };
        } else {
          assert.fail(`Unexpected fixture verb ${name}`);
        }
        return {
          status: () => 200,
          json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }),
        };
      },
    };

    const fixture = await createLoopFixture(request, kind);
    assert.match(fixture.title, /^Synthetic staging QA /);
    await fixture.cleanup();
    assert.equal(loop.status, 'done');
    assert.deepEqual(calls, ['add-loop', 'read-loop', 'close-loop', 'read-loop']);
  });
}
