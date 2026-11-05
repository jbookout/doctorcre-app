import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveClient } from '../js/live-client.js';
const fixture = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/subject-watch.fixture.json',import.meta.url),'utf8'));

test('watch adapters preserve exact requests, session authority and partner isolation', async () => {
  const watches = new Map(), receipts = new Map(), calls = [];
  let loseReceipt = true;
  const clientFor = actor => createLiveClient({selfActor:actor,fetchImpl:async (path,init) => {
    if (path === '/auth/session') return Response.json({actor:{slug:actor},csrf_token:`synthetic-${actor}`});
    const {params} = JSON.parse(init.body); calls.push({actor,...params});
    const args = params.arguments;
    assert.equal(Object.hasOwn(args,'actor'),false);
    let value;
    if (params.name === 'read-subject-watch-v1') value = {ok:true,schema_version:'subject-watch.v1',watch:watches.get(actor) || null};
    else {
      assert.equal(init.headers['x-carr-csrf'],`synthetic-${actor}`);
      const key = `${actor}|${args.idempotency_key}`;
      value = receipts.get(key);
      if (!value) {
        value = structuredClone(params.name === 'watch-subject-v1' ? fixture.watch_response : fixture.unwatch_response);
        watches.set(actor,value.watch); receipts.set(key,value);
      } else value = {...value,replayed:true};
      if (actor === 'joe' && loseReceipt) { loseReceipt = false; throw Error('Synthetic lost response'); }
    }
    return Response.json({result:{content:[{text:JSON.stringify(value)}]}});
  }});
  const joe = clientFor('joe'), dell = clientFor('dell');
  const args = fixture.write_request.arguments;
  const subject = {subject_type:args.subject_type,subject_id:args.subject_id};
  await dell.watchSubject({...args,idempotency_key:'00000000-0000-4000-8000-000000000005'});
  const prior = await dell.readSubjectWatch(subject);
  await assert.rejects(joe.watchSubject(args));
  assert.equal((await joe.watchSubject(args)).replayed,true);
  assert.deepEqual(calls.filter(x => x.actor === 'joe').map(x => x.arguments),[args,args]);
  await joe.unwatchSubject({...args,idempotency_key:'00000000-0000-4000-8000-000000000006'});
  assert.equal((await joe.readSubjectWatch(subject)).watch,null);
  assert.deepEqual(await dell.readSubjectWatch(subject),prior);
});

test('watch writes refuse a changed session before transport', async () => {
  let writes = 0;
  const client = createLiveClient({selfActor:'joe',fetchImpl:async path => {
    if (path === '/auth/session') return Response.json({actor:{slug:'dell'},csrf_token:'synthetic-dell'});
    ++writes; throw Error('Unexpected write');
  }});
  await assert.rejects(client.watchSubject(fixture.write_request.arguments),{code:'session_changed'});
  assert.equal(writes,0);
});
