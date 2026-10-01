import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDoctorcreRequest } from '../src/worker.js';
import { canonicalPassport } from '../js/progress-work-model.js';
import { passportProjectionDigest } from '../js/job-passport.js';
import fixture from './fixtures/progress-work.synthetic.json' with {type:'json'};

test('canonical Engineering read accepts current-generation arrays and refuses a broken seal',()=>{
  const read={...fixture.engineering,current_receipts:fixture.engineering.receipts,current_reviewer_facts:[]};
  read.projection_digest=passportProjectionDigest(read);
  assert.equal(canonicalPassport(read),true);
  assert.equal(canonicalPassport({...read,closure_state:'complete'}),false);
  assert.equal(canonicalPassport({...read,current_receipts:null}),false);
});

test('Observatory URLs redirect into Progress and retain deep links', async () => {
  for (const [old, view] of [['/room.html','wire'], ['/agent-room','wire'], ['/queue.html','tasks'], ['/control-room/agents/queue','tasks']]) {
    const response = await handleDoctorcreRequest(new Request(`https://example.test${old}?board=synthetic&task=t_demo&session=s_demo#wireFeed`), {});
    assert.equal(response.status, 308);
    const to = new URL(response.headers.get('location'));
    assert.equal(to.pathname, '/control-room/progress/work');
    assert.equal(to.searchParams.get('view'), view);
    assert.equal(to.searchParams.get('board'), 'synthetic');
    assert.equal(to.searchParams.get('task'), 't_demo');
    assert.equal(to.searchParams.get('session'), 's_demo');
    assert.equal(to.hash, '#wireFeed');
  }
});

test('Progress work detail uses the existing Control Room auth gate', async () => {
  const requests = [];
  const response = await handleDoctorcreRequest(new Request('https://example.test/control-room/progress/work?board=synthetic&task=t_demo'), {
    CARR: { fetch: async request => { requests.push(request.url); return new Response(null, { status: 302, headers: { location: '/auth/login?return_to=/control-room' } }); } },
  });
  assert.equal(new URL(requests[0]).pathname, '/control-room');
  assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'), '/control-room/progress/work?board=synthetic&task=t_demo');
});
