import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {createLiveClient} from '../js/live-client.js';
import {boardView, deliveryDetail} from '../js/progress-board-model.js';
import {mountJobDetail} from '../js/job-detail.js';

test('a compact published board restores every task fact before cards and raw details read it', async () => {
  const read = {ok:true, snapshot:{board_id:'synthetic', version:3,
    updated_at:'2026-10-19T12:00:00Z', snapshot_json:{schema:'carr-progress-board.v3',
      task_defaults:{status:'review', executor:'Codex gpt-6-sol high', evidence:'https://example.test/proof',
        question:'Synthetic review question', health:'question', optional:true,
        consumer_proof:{result:'passed', receipt:{ref:'synthetic-receipt', observations:['original detail']}},
        stage_history:[{stage:'queued', entered_at:'2026-10-18T12:00:00Z'},
          {stage:'review', entered_at:'2026-10-19T11:00:00Z'}]},
      tasks:{inherited:{title:'Synthetic inherited task'}, overridden:{title:'Synthetic overrides',
        status:'running', executor:'', evidence:null, question:'', health:'healthy', optional:false,
        consumer_proof:{result:'failed', receipt:{ref:'different-receipt'}}, stage_history:[]}}}}, questions:[]};
  const original = structuredClone(read);
  const client = createLiveClient({fetchImpl:async () => new Response(JSON.stringify({result:{content:[{text:JSON.stringify(read)}]}}))});
  const expanded = await client.readProgressBoard({board_id:'synthetic'});
  assert.deepEqual(expanded.snapshot.snapshot_json.tasks, {
    inherited:{title:'Synthetic inherited task', status:'review', executor:'Codex gpt-6-sol high',
      evidence:'https://example.test/proof', question:'Synthetic review question', health:'question', optional:true,
      consumer_proof:{result:'passed', receipt:{ref:'synthetic-receipt', observations:['original detail']}},
      stage_history:[{stage:'queued', entered_at:'2026-10-18T12:00:00Z'},
        {stage:'review', entered_at:'2026-10-19T11:00:00Z'}]},
    overridden:{title:'Synthetic overrides', status:'running', executor:'', evidence:null, question:'',
      health:'healthy', optional:false, consumer_proof:{result:'failed', receipt:{ref:'different-receipt'}}, stage_history:[]},
  });
  assert.equal('task_defaults' in expanded.snapshot.snapshot_json, false);
  assert.deepEqual(read, original);
  const at = new Date('2026-10-19T12:00:00Z');
  const view = boardView(expanded, at);
  assert.equal(view.error, null);
  assert.deepEqual(boardView(read, at), view, 'direct model consumers expand the same envelope');
  assert.equal(view.cards[0].stage, 'review');
  assert.deepEqual(deliveryDetail(view.cards[0], at).history.map(row => row.stage), ['queued','review']);
  const dom = new JSDOM(await readFile(new URL('../control-room.html', import.meta.url), 'utf8'), {url:'https://example.test/control-room'});
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
  const detail = mountJobDetail({client, document:dom.window.document});
  detail.open(view.cards[0]);
  const body = dom.window.document.getElementById('jobBody').textContent;
  assert.match(body, /synthetic-receipt/);
  assert.match(body, /original detail/);
  assert.match(body, /2026-10-18T12:00:00Z/);
  dom.window.close();
});
