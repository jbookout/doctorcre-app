import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVisibilityPoll } from '../js/visibility-poll.mjs';
import { mountAutoRefresh } from '../js/auto-refresh.mjs';

function clock() {
  let time = 0, next = 0;
  const jobs = new Map(), document = new EventTarget(), window = new EventTarget();
  document.visibilityState = 'visible';
  window.setTimeout = (fn, ms) => { jobs.set(++next, {fn, at: time + ms}); return next; };
  window.clearTimeout = id => jobs.delete(id);
  const settle = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
  return { document, window, now: () => time,
    async advance(ms) {
      const end = time + ms;
      for(let steps=0;steps<10_000;steps++) {
        const at=Math.min(...[...jobs.values()].map(job=>job.at));
        if(at>end) break;
        time=at;
        for(const [id,job] of [...jobs]) if(job.at===at){jobs.delete(id);job.fn();}
        await settle();
        assert.ok(steps<9999,'clock must make finite progress');
      }
      time=end; await settle();
    },
    scroll() { const event=new Event('scroll');Object.defineProperty(event,'isTrusted',{value:true});document.dispatchEvent(event); },
    lifecycle() { window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true})); },
  };
}
for(const helper of [mountVisibilityPoll,mountAutoRefresh]) test(`${helper.name}: auto-scroll and lifecycle storms cannot replenish a 24-hour budget`,async()=>{
 const c=clock();let reads=0;
 const read=()=>{reads++;c.scroll();};
 const handle=helper({...c,lifecycle:true,poll:read,refresh:read});
 await handle.refresh();
 for(let minute=0;minute<1440;minute++){
  c.scroll();c.lifecycle();await c.advance(60_000);
 }
 assert.ok(reads<=20,`24-hour logical read ceiling is 20, observed ${reads}`);
 const stopped=reads;await c.advance(24*60*60_000);assert.equal(reads,stopped);
 handle.dispose();
});

for(const helper of [mountVisibilityPoll,mountAutoRefresh]) test(`${helper.name}: lifecycle events respect failure backoff and idle`,async()=>{
 const c=clock();let reads=0;
 const fail=()=>{reads++;throw Error('synthetic outage');};
 const handle=helper({...c,lifecycle:true,poll:fail,refresh:fail});
 await handle.refresh();
 for(let i=0;i<1000;i++)c.lifecycle();
 await c.advance(119_999);assert.equal(reads,1);
 await c.advance(1);assert.equal(reads,2);
 await c.advance(31*60_000);const stopped=reads;
 for(let i=0;i<1000;i++)c.lifecycle();
 await c.advance(60*60_000);assert.equal(reads,stopped);
 handle.dispose();
});

for(const helper of [mountVisibilityPoll,mountAutoRefresh]) test(`${helper.name}: 24 hours of automatic wire scrolling alone has a 20-read ceiling`,async()=>{
 const c=clock();let reads=0;
 const read=()=>{reads++;c.scroll()};
 const handle=helper({...c,lifecycle:true,poll:read,refresh:read});await handle.refresh();
 for(let minute=0;minute<1440;minute++){c.scroll();await c.advance(60_000)}
 assert.equal(reads,13,'13 reads before idle, then no further reads across 24 hours');
 handle.dispose();
});
