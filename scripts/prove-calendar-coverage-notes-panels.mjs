import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

// Recorded synthetic calendarSection output from CARR f08895ac514770f8ce6eb00a29159a6072da9c46.
export const producerFixture = {
  "state": "partial",
  "source": "outlook_local_store",
  "notes": [
    "2 calendar items in Outlook couldn't be read, so meetings may be missing.",
    "1 meeting has more than one stored time. Check Outlook for the current time.",
    "This calendar was last read from Outlook more than 18 hours ago."
  ],
  "observed_at": "2026-11-03T10:00:00.000Z",
  "sources": {
    "outlook_calendar": {
      "state": "stale"
    }
  },
  "items": [
    {
      "start": "2026-11-05T14:00:00.000Z",
      "end": "2026-11-05T15:00:00.000Z",
      "title": "Synthetic meeting",
      "location": null,
      "organizer": {
        "name": null,
        "email": null
      },
      "attendees": [],
      "attendee_count": 0,
      "all_day": false,
      "recurring": false,
      "time_changed": false,
      "times": [],
      "conflict": false,
      "schedule_conflict": false,
      "schedule_conflicts": [],
      "schedule_conflicts_omitted": 0
    }
  ]
};

export async function observeCoverage(page, fixture = producerFixture) {
  return page.evaluate(async fixture => {
    const { createLiveClient } = await import('/js/live-client.js');
    const client = createLiveClient({ fetchImpl: async (_path, init) => {
      const request = JSON.parse(init.body);
      if (request.params.name !== 'calendar-meeting-prep') throw Error('Unexpected read');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(fixture) }] } }), { headers: { 'content-type': 'application/json' } });
    } });
    const { mountCalendarPanels } = await import('/js/ui-calendar-panels.generated.js');
    const left = document.querySelector('#left'), right = document.querySelector('#right');
    const panel = await mountCalendarPanels(left, right);
    panel.render(await client.calendarMeetingPrep());
    return { notes: [...left.querySelectorAll('details li')].map(node => node.textContent),
      rightNotes: [...right.querySelectorAll('details li')].map(node => node.textContent),
      partial: left.textContent.includes('Calendar coverage is incomplete.'),
      meetings: left.querySelectorAll('.calendar-panel-meeting').length };
  }, fixture);
}

export async function prove({ origin, timeoutMs = 30000, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.origin === origin && !base.username && !base.password, 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded deadline');
  const controller = new AbortController();
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const timer = setTimeout(() => controller.abort(unavailable('Proof deadline exceeded')), timeoutMs);
  const assets = new Map();
  let browser, requests = 0, bytes = 0, routeFailure;
  async function read(url) {
    assert.ok(++requests <= 64, 'request cap');
    const response = await proofFetch(url, { signal: controller.signal });
    if (!response.ok) throw unavailable(`Asset HTTP ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap');
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  }
  try {
    const before = await readAppRelease(base, read);
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal: controller.signal });
    const context = await browser.newContext({ timezoneId: 'America/Chicago', serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.origin !== origin) return route.abort();
      if (url.pathname === '/__coverage-proof') return route.fulfill({ contentType: 'text/html', body: '<div id="left"></div><div id="right"></div>' });
      if (!url.pathname.startsWith('/js/') || !/\.m?js$/.test(url.pathname)) return route.abort();
      try {
        if (!assets.has(url.href)) assets.set(url.href, await read(url));
        const asset = assets.get(url.href);
        assert.match(asset.type, /javascript/);
        await route.fulfill({ contentType: asset.type, body: asset.body });
      } catch (error) { routeFailure = error; await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-05T12:30:00Z'));
    await page.goto(new URL('/__coverage-proof', base).href);
    const observation = await observeCoverage(page);
    if (routeFailure) throw routeFailure;
    assert.deepEqual(observation.notes, producerFixture.notes);
    assert.deepEqual(observation.rightNotes, producerFixture.notes);
    assert.equal(observation.partial, true);
    assert.equal(observation.meetings, 1);
    const after = await readAppRelease(base, read);
    assert.deepEqual(after, before, 'release unchanged');
    return { ok: true, deployed_asset_fixture: { passed: true, observation }, natural_authenticated_observation: { status: 'insufficient_evidence', reason: 'No signed-in session is acquired by this synthetic runner.' }, production_acceptance: false, release: before, requests, bytes };
  } catch (error) { throw controller.signal.aborted ? controller.signal.reason : routeFailure || error; }
  finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 4 && args[0] === '--origin' && args[2] === '--timeout-ms', 'usage: --origin URL --timeout-ms 30000');
    console.log(JSON.stringify(await prove({ origin: args[1], timeoutMs: Number(args[3]) })));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, production_acceptance: false }));
    process.exitCode = error.exitCode || 1;
  }
}
