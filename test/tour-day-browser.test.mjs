import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "./browser-harness.mjs";
import { detail, tourId } from "./fixtures/tour-day.synthetic.mjs";
import { handleDoctorcreRequest } from "../src/worker.js";
const root = new URL("../", import.meta.url);

async function open(t, { width = 390, reducedMotion = "reduce", denied = false, workerHeaders = false } = {}) {
  const requests = [], errors = [], current = structuredClone(detail);
  let actor = "joe", refuse = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost"); requests.push({ path: url.pathname, method: request.method });
    if (url.pathname === "/auth/signout") { refuse = true; response.end('{}'); return; }
    if (url.pathname === "/auth/login") { response.end('<title>Synthetic login</title>'); return; }
    if (url.pathname.startsWith("/api/")) {
      response.setHeader("content-type", "application/json");
      if (refuse) { response.writeHead(401); response.end('{}'); return; }
      response.end(JSON.stringify(url.pathname === "/api/system-work/session" ? { actor: { slug: actor }, csrf_token: `synthetic-${actor}` } : url.pathname === "/api/tours/detail" ? { data: current } : {})); return;
    }
    try {
      const file = url.pathname === "/tours" ? "tours/index.html" : url.pathname.slice(1);
      if (file.includes("..")) throw new Error("invalid path");
      response.setHeader("content-type", file.endsWith(".css") ? "text/css" : /\.m?js$/.test(file) ? "text/javascript" : "text/html");
      if (workerHeaders) {
        const secured = await handleDoctorcreRequest(new Request(`https://doctorcre.com${url.pathname}`), { CARR: { fetch: async () => new Response('synthetic gate') }, ASSETS: { fetch: async () => new Response('synthetic asset') } });
        for (const header of ['content-security-policy', 'permissions-policy', 'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy']) response.setHeader(header, secured.headers.get(header));
      }
      response.end(await readFile(new URL(file, root)));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion });
  const context = page.context(); page.on("pageerror", e => errors.push(e.message));
  // All tests stay on the local synthetic server. Call/navigation links are
  // inspected as strings and never activated.
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.syntheticRecorders = [];
    window.syntheticRecordingErrors = [];
    window.syntheticMicEvents = [];
    window.syntheticChunks = [];
    window.syntheticAudioBlobs = {};
    const createURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) { const url = createURL.call(this, blob); window.syntheticAudioBlobs[url] = blob; return url; };
    // A local oscillator feeds the real MediaRecorder encoder. No system
    // microphone, OS consent, live conversation or speaker output is involved.
    navigator.mediaDevices.getUserMedia = async () => {
      window.syntheticMicEvents.push("requested");
      const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      window.syntheticMicEvents.push("granted"); return destination.stream;
    };
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function(...args) {
      window.syntheticRecorders.push(this);
      this.addEventListener('dataavailable', event => { if (event.data.size) window.syntheticChunks.push(event.data); });
      try { return start.apply(this, args); } catch (error) { window.syntheticRecordingErrors.push(error.message); throw error; }
    };
  });
  if (denied) await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); }; });
  t.after(async () => { await browser.close(); await new Promise(r => server.close(r)); });
  await page.goto(`${origin}/tours/day.html?tour=${tourId}`);
  await page.waitForFunction(() => document.querySelector("#day-title").textContent === "Synthetic tour").catch(async error => { throw new Error(JSON.stringify({ errors, text: await page.locator("body").textContent(), requests }) + error.message); });
  await page.waitForFunction(() => !document.querySelector("#day-record").disabled);
  return { page, context, requests, errors, current, origin, setActor(value) { actor = value; }, refuse() { refuse = true; } };
}
const record = async page => {
  await page.locator("#day-record").click();
  await page.waitForFunction(() => document.querySelector("#day-record").hasAttribute("data-recording")).catch(async error => { throw new Error(JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#day-status').textContent, visibility: document.visibilityState, text: document.querySelector('#day-record').textContent, states: window.syntheticRecorders.map(r => r.state), errors: window.syntheticRecordingErrors, mic: window.syntheticMicEvents }))) + ' ' + error.message); });
  await page.waitForFunction(() => window.syntheticRecorders.some(r => r.state === "recording")).catch(async error => { throw new Error(JSON.stringify(await page.evaluate(() => ({ errors: window.syntheticRecordingErrors, mic: window.syntheticMicEvents, count: window.syntheticRecorders.length, status: document.querySelector("#day-status").textContent, recording: document.querySelector("#day-record").hasAttribute("data-recording") }))) + error.message); });
  await page.waitForTimeout(1300);
  await page.locator("#day-record").click();
  await page.waitForFunction(() => !document.querySelector("#day-record").hasAttribute("data-recording"));
  await page.waitForFunction(() => document.querySelector(".note-card")?.textContent.includes("Saved on phone")).catch(async error => { throw new Error(await page.locator("#tour-day").textContent() + error.message); });
};

test("W16 desktop and phone renders: reachable capture, wide Details, full width and reduced motion", async t => {
  await mkdir(new URL("test-artifacts/w16/", root), { recursive: true });
  for (const width of [1440, 761, 760, 721, 390, 320]) await t.test(String(width), async t => {
    const { page, requests, errors } = await open(t, { width });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('body.has-app-layout').waitFor();
    assert.equal(await page.locator('#appMainSlot #tour-day').count(), 1, 'Tour day belongs in the workspace main region');
    const record = await page.locator("#day-record").boundingBox();
    const status = await page.locator('.app-layout-status').boundingBox();
    assert.ok(record.width >= 140 && record.height >= 60 && record.y + record.height < status.y,
      JSON.stringify({record,status,width}));
    const dock = await page.locator('.capture-dock').boundingBox();
    const docPresence = await page.locator('#docPresence').boundingBox();
    assert.ok(dock.x + dock.width <= docPresence.x || docPresence.x + docPresence.width <= dock.x ||
      dock.y + dock.height <= docPresence.y || docPresence.y + docPresence.height <= dock.y,
      `Capture and Doc must not overlap: ${JSON.stringify({ dock, docPresence, width })}`);
    for (const id of ['day-record', 'day-previous', 'day-next', 'docOpen', 'docBriefOpen']) assert.equal(await page.locator('#' + id).evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, `The shared shell must leave ${id} reachable`);
    assert.equal(await page.locator(".day-stop").count(), 2);
    assert.match(await page.locator("#day-current").textContent(), /100 Example Way.*Demo listing contact.*West entrance/s);
    assert.equal(await page.locator(".property-actions a").getAttribute("href"), "tel:+12025550100");
    await page.locator(".day-stop").nth(1).click();
    assert.equal(await page.locator("#day-dialog").isVisible(), true);
    const dialog = await page.locator("#day-dialog").boundingBox(); assert.ok(dialog.width >= Math.min(1000, width - 24));
    assert.match(await page.locator("#day-dialog-body").textContent(), /200 Example Way.*north lobby/s);
    if ([1440, 390, 320].includes(width)) await page.screenshot({ path: new URL(`test-artifacts/w16/details-${width}.png`, root).pathname, fullPage: true });
    await page.getByLabel("Close property", { exact: true }).click();
    await page.locator("#day-previous").click();
    assert.match(await page.locator("#day-current").textContent(), /waterfront/);
    assert.equal(await page.locator("#day-record").evaluate(e => getComputedStyle(e).animationName), "none");
    assert.equal(await page.locator(".day-stop").first().evaluate(e => getComputedStyle(e).transitionDuration), "0s");
    const copy = await page.locator("#tour-day").textContent(); assert.doesNotMatch(copy, /record layer|source|Read again|retry read|records read|Search Mode/i);
    await page.evaluate(() => window.scrollTo(0, 0));
    if ([1440, 390, 320].includes(width)) await page.screenshot({ path: new URL(`test-artifacts/w16/day-${width}.png`, root).pathname, fullPage: true });
    assert.deepEqual(errors, []); assert.equal(requests.some(r => r.method !== "GET"), false);
  });
});

test("browser MediaRecorder audio is durable per property and Details preserves its original bytes", async t => {
  const { page, requests, errors } = await open(t, { workerHeaders: true });
  await record(page);
  await page.locator(".note-card").click(); await page.locator("#day-dialog summary").click();
  assert.equal(await page.locator("#day-dialog audio").count(), 1);
  assert.match(await page.locator("#day-dialog-body").textContent(), /Transcript pending/);
  await page.locator('#day-dialog audio').evaluate(async e => { await e.play(); e.pause(); });
  const original = await page.evaluate(async () => [...new Uint8Array(await new Blob(window.syntheticChunks).arrayBuffer())]);
  const bytes = await page.locator('#day-dialog audio').evaluate(async e => [...new Uint8Array(await window.syntheticAudioBlobs[e.src].arrayBuffer())]);
  assert.ok(bytes.length > 100); assert.deepEqual(bytes, original);
  await page.screenshot({ path: new URL("test-artifacts/w16/phone-note-details.png", root).pathname, fullPage: true });
  await page.getByLabel("Close property", { exact: true }).click();
  await page.locator("#day-next").click(); assert.equal(await page.locator(".note-card").count(), 0);
  await page.reload(); await page.waitForFunction(() => document.querySelector("#day-current").textContent.includes("garden"));
  await page.locator("#day-previous").click(); await page.locator(".note-card").click(); await page.locator("#day-dialog summary").click();
  assert.deepEqual(await page.locator('#day-dialog audio').evaluate(async e => [...new Uint8Array(await window.syntheticAudioBlobs[e.src].arrayBuffer())]), original);
  assert.deepEqual(errors, []); assert.equal(requests.some(r => r.method !== "GET"), false);
});

test('R3: real synthetic audio encodes under Worker headers; other documents deny microphone policy', async t => {
  const { page, origin } = await open(t, { workerHeaders: true });
  assert.equal(await page.evaluate(() => document.featurePolicy.allowsFeature('microphone')), true);
  await record(page);
  assert.deepEqual(await page.evaluate(() => window.syntheticMicEvents), ['requested', 'granted']);
  assert.equal(await page.evaluate(() => window.syntheticRecorders[0].stream.getAudioTracks().length), 1);
  assert.ok(await page.evaluate(() => new Blob(window.syntheticChunks).size > 100), 'the browser encoder must produce audio');
  const other = await handleDoctorcreRequest(new Request('https://doctorcre.com/tours/index.html'), { ASSETS: { fetch: async () => new Response('synthetic') } });
  assert.match(other.headers.get('permissions-policy'), /microphone=\(\)/);
  await page.goto(`${origin}/tours/index.html`);
  assert.equal(await page.evaluate(() => document.featurePolicy.allowsFeature('microphone')), false);
});

test('R2: shared shell sign-out revokes the offline account binding', async t => {
  const { page, context, origin } = await open(t);
  await page.goto(`${origin}/tours/day.html?tour=${tourId}&mode=live`);
  await page.waitForFunction(() => !document.querySelector('#day-record').disabled);
  await record(page);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/tours/day-sw.js', { scope: '/tours/' }); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.locator('#selfAvatar').click(); await page.locator('#accountSignOut').click();
  await page.waitForURL('**/auth/login');
  await context.setOffline(true); await page.goto(`${origin}/tours/day.html?tour=${tourId}`);
  await page.waitForFunction(() => document.querySelector('#day-status')?.textContent === 'Tour unavailable');
  assert.equal(await page.locator('.note-card').count(), 0); assert.equal(await page.locator('.day-stop').count(), 0); assert.equal(await page.locator('#day-record').isDisabled(), true);
});

test('R6: another tab cannot finalize a live owner recording', async t => {
  const { page, context, origin } = await open(t);
  await page.locator('#day-record').click(); await page.waitForFunction(() => window.syntheticRecorders[0]?.state === 'recording');
  await page.waitForTimeout(1300);
  const second = await context.newPage(); await second.goto(`${origin}/tours/day.html?tour=${tourId}`); await second.waitForSelector('.note-card');
  assert.equal(await page.evaluate(() => window.syntheticRecorders[0].state), 'recording');
  assert.match(await second.locator('.note-card').textContent(), /Recording/);
  assert.doesNotMatch(await second.locator('.note-card').textContent(), /Saved on phone/);
  await page.locator('#day-record').click(); await page.waitForFunction(() => document.querySelector('.note-card')?.textContent.includes('Saved on phone'));
  await second.locator('#day-refresh').click(); await second.waitForFunction(() => document.querySelector('.note-card')?.textContent.includes('Saved on phone'));
});

test('R10: map pin, list and dock share one restored selection', async t => {
  const { page } = await open(t);
  await page.locator('[data-route-stop-id="66666666-6666-4666-8666-666666666666"]').click();
  await page.waitForFunction(() => document.querySelector('#day-current').textContent.includes('garden'));
  await page.reload(); await page.waitForFunction(() => document.querySelector('#day-title').textContent === 'Synthetic tour');
  assert.match(await page.locator('#day-current').textContent(), /garden/);
  await page.locator('#day-previous').click(); await page.reload(); await page.waitForFunction(() => document.querySelector('#day-title').textContent === 'Synthetic tour');
  assert.match(await page.locator('#day-current').textContent(), /waterfront/);
});

test("mic denial recovers controls; recording freezes property while tour reads keep updating", async t => {
  const denied = await open(t, { denied: true });
  await denied.page.locator("#day-record").click(); await denied.page.waitForFunction(() => document.querySelector("#day-status").textContent === "Microphone access denied");
  assert.equal(await denied.page.locator("#day-next").isEnabled(), true);
  const active = await open(t); await active.page.locator("#day-record").click();
  await active.page.waitForFunction(() => document.querySelector("#day-record").hasAttribute("data-recording"));
  assert.equal(await active.page.locator("#day-next").isDisabled(), true);
  active.current.routes[0].stops[0].access_notes = "Synthetic updated access";
  await active.page.locator("#day-refresh").click(); await active.page.waitForFunction(() => document.querySelector("#day-current").textContent.includes("updated access"));
  assert.equal(await active.page.locator("#day-record").getAttribute("data-recording"), "");
  await active.page.locator("#day-record").click();
});

test("account swap and authentication refusal hide previous drafts; no automatic upload effects", async t => {
  const { page, requests, setActor, refuse } = await open(t);
  await record(page); setActor("dell"); await page.locator("#day-refresh").click();
  await page.waitForFunction(() => document.querySelector("#day-status").textContent === "Session changed");
  assert.equal(await page.locator(".note-card").count(), 0);
  await page.locator("#day-refresh").click(); await page.waitForFunction(() => document.querySelector("#day-title").textContent === "Synthetic tour");
  assert.equal(await page.locator(".note-card").count(), 0);
  refuse(); await page.locator("#day-refresh").click(); await page.waitForFunction(() => document.querySelector("#day-status").textContent === "Sign in to continue");
  assert.equal(await page.locator("#day-record").isDisabled(), true); assert.equal(await page.locator(".day-stop").count(), 0);
  assert.equal(requests.some(r => r.method !== "GET"), false);
});

test("static offline shell reload resumes tour and audio in the same tab, then reconnects automatically", async t => {
  const { page, context, errors } = await open(t);
  await record(page);
  await page.evaluate(async () => { const r = await navigator.serviceWorker.register("/tours/day-sw.js", { scope: "/tours/" }); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('doctorcre-tour-day-shell-'));
    if (names.length !== 1) throw new Error('Expected one current tour shell cache');
    return (await (await caches.open(names[0])).keys()).map(r => new URL(r.url).pathname);
  });
  assert.ok(cached.includes('/js/slices.generated.js'));
  assert.ok(cached.includes('/js/slices/tours.js'));
  assert.equal(cached.some(path => path.startsWith("/api/")), false);
  await context.setOffline(true); await page.reload();
  await page.waitForFunction(() => document.querySelector("#day-status")?.textContent.includes("Offline"));
  assert.equal(await page.locator(".day-stop").count(), 2); assert.equal(await page.locator(".note-card").count(), 1);
  assert.equal(await page.locator("#appMainSlot #tour-day").count(), 1);
  assert.equal(await page.getByLabel("Workspace sidebar", { exact: true }).isVisible(), true);
  await page.screenshot({ path: new URL("test-artifacts/w16/phone-offline.png", root).pathname, fullPage: true });
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector("#day-status").textContent === "Voice notes stay on this phone");
  assert.equal(await page.locator(".note-card").count(), 1); assert.deepEqual(errors, []);
});

test("open property and note popups update automatically without closing Details", async t => {
  const { page, current, errors } = await open(t);
  await record(page); await page.locator(".note-card").click(); await page.locator("#day-dialog summary").click();
  current.routes[0].stops[0].access_notes = "Synthetic updated entry";
  // Resume is a read-only refresh; it does not require an in-modal retry button.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => document.querySelector("#day-dialog-body").textContent.includes("updated entry"));
  assert.equal(await page.locator("#day-dialog details").evaluate(e => e.open), true);
  assert.equal(await page.locator("#day-dialog audio").count(), 1); assert.deepEqual(errors, []);
});
