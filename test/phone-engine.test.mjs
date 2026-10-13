import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journeyEngine } from '../tests/journeys/phone-engine.mjs';
import { journeyProfiles } from '../tests/journeys/phone-profiles.mjs';

// Drives each engine through the SPI calls the runner makes, against a
// synthetic page, so a phone tap is held to the desktop adapter's semantics.
const page = `<!doctype html><meta name="viewport" content="width=device-width">
<main><button hidden>Continue</button><button id="shown">Continue</button>
<input id="amount" aria-label="Amount" value="42">
<button id="twin" onclick="single.before(Object.assign(document.createElement('button'), { id: 'inserted', textContent: 'Save' }))">Add twin</button>
<button id="single">Save</button>
<button id="arm" onclick="setTimeout(() => { late.disabled = false; }, 300)">Arm</button>
<button id="late" disabled>Later</button></main><output id="log"></output>
<script>
for (const type of ['touchstart', 'click']) addEventListener(type, event => {
  if (event.isTrusted) document.getElementById('log').textContent += type + ':' + event.target.id + ' ';
}, true);
</script>`;

async function drive(profileName, run) {
  const server = createServer((request, response) => response.end(page));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const engine = journeyEngine(journeyProfiles.find(profile => profile.name === profileName));
  const signal = new AbortController().signal;
  const operation = (overrides = {}) => ({ signal, timeoutMs: 5_000, runId: 'run', attemptId: 'attempt', origin: 'test', ...overrides });
  await engine.init({ app: { url, site: new URL(url).origin }, projectRoot: process.cwd(), headed: false, signal, env: process.env, log: () => {} });
  try {
    await engine.startAttempt({ artifactsDir: await mkdtemp(join(tmpdir(), 'phone-engine-')), signal, attemptId: 'attempt', resolveSecret: async () => '' });
    await engine.session.open(url, operation());
    const log = async () => (await engine.locate({ kind: 'selector', selector: '#log' }, operation()))[0].text.trim();
    const tap = async (expression, overrides) => {
      const nodes = await engine.locate(expression, operation());
      assert.equal(nodes.length, 1);
      await engine.perform(nodes[0].ref, { kind: 'tap' }, operation(overrides));
    };
    await run({ engine, operation, log, tap });
  } finally {
    await engine.endAttempt({ signal }).catch(() => {});
    await engine.dispose({ signal }).catch(() => {});
    server.close();
  }
}

const text = value => ({ kind: 'string', value, exact: true });
const query = (kind, value, extra = {}) => ({ kind: 'query', query: { kind, value: text(value), ...extra } });
const touchProfiles = journeyProfiles.filter(profile => profile.name !== 'chromium').map(profile => profile.name);
// Desktop click and phone touch must agree on what each reference names.
const expected = (name, ids) => ids.flatMap(id => name === 'chromium' ? [`click:${id}`] : [`touchstart:${id}`, `click:${id}`]).join(' ');

for (const name of ['chromium', ...touchProfiles]) {
  test(`${name}: a visible text query taps the shown twin, not the hidden one`, async () => {
    await drive(name, async ({ tap, log }) => {
      await tap(query('text', 'Continue', { visible: true }));
      assert.equal(await log(), expected(name, ['shown']));
    });
  });

  test(`${name}: a displayValue query resolves and taps its control`, async () => {
    await drive(name, async ({ tap, log }) => {
      await tap(query('displayValue', '42'));
      assert.equal(await log(), expected(name, ['amount']));
    });
  });

  test(`${name}: a reference that turns ambiguous before perform acts on nothing`, async () => {
    await drive(name, async ({ engine, operation, tap, log }) => {
      const [save] = await engine.locate(query('role', 'button', { name: text('Save') }), operation());
      await tap({ kind: 'selector', selector: '#twin' });
      await assert.rejects(engine.perform(save.ref, { kind: 'tap' }, operation({ timeoutMs: 1_000 })));
      assert.equal(await log(), expected(name, ['twin']));
    });
  });

  test(`${name}: a cancelled tap dispatches nothing`, async () => {
    await drive(name, async ({ tap, log }) => {
      await assert.rejects(tap({ kind: 'selector', selector: '#single' }, { signal: AbortSignal.abort() }));
      assert.equal(await log(), '');
    });
  });

  test(`${name}: a disabled control is touched only once it enables`, async () => {
    await drive(name, async ({ tap, log }) => {
      await tap({ kind: 'selector', selector: '#arm' });
      await tap({ kind: 'selector', selector: '#late' });
      assert.equal(await log(), expected(name, ['arm', 'late']));
    });
  });
}

test('a phone target cannot silently lose mobile or touch emulation', () => {
  for (const profile of journeyProfiles.filter(profile => profile.name !== 'chromium'))
    for (const change of [{ hasTouch: false }, { isMobile: false }])
      assert.throws(() => journeyEngine({ ...profile, ...change }), /Phone profile/);
});
