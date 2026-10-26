import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { detail, tourId } from "./fixtures/tour-day.synthetic.mjs";
import { receipt as mapReceipt } from "./fixtures/tour-map.synthetic.mjs";
import { handleDoctorcreRequest } from "../src/worker.js";
const root = new URL("../", import.meta.url);

async function open(t, { width = 390, reducedMotion = "reduce", denied = false, workerHeaders = false, fixture = detail, basemap = false } = {}) {
  const requests = [], errors = [], current = structuredClone(fixture);
  let actor = "joe", refuse = false, sessionFailure = null, shellFailure = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost"); requests.push({ path: url.pathname, method: request.method });
    if (url.pathname === "/auth/signout") { refuse = true; response.writeHead(302, { location: '/' }); response.end(); return; }
    if (url.pathname === "/auth/session") { response.setHeader('content-type', 'application/json'); response.writeHead(refuse ? 401 : 200); response.end(JSON.stringify(refuse ? {} : {actor:{slug:actor},csrf_token:`synthetic-${actor}`})); return; }
    if (url.pathname === "/auth/login") { response.end('<title>Synthetic login</title>'); return; }
    if (url.pathname.startsWith("/api/")) {
      response.setHeader("content-type", "application/json");
      if (refuse) { response.writeHead(401); response.end('{}'); return; }
      if (url.pathname === '/api/system-work/session' && sessionFailure) {
        if (sessionFailure === 'hang') return;
        response.writeHead(sessionFailure); response.end('{}'); return;
      }
      response.end(JSON.stringify(['/api/system-work/session','/auth/session'].includes(url.pathname) ? { actor: { slug: actor }, csrf_token: `synthetic-${actor}` } : url.pathname === "/api/tours/detail" ? { data: current } : {})); return;
    }
    try {
      if (shellFailure && !url.pathname.endsWith('day-sw.js') && !url.pathname.endsWith('day-shell.generated.js')) { response.writeHead(503); response.end('Unavailable'); return; }
      const file = url.pathname === "/tours" ? "tours/index.html" : url.pathname.slice(1);
      if (file.includes("..")) throw new Error("invalid path");
      response.setHeader("content-type", file.endsWith(".css") ? "text/css" : /\.m?js$/.test(file) ? "text/javascript" : "text/html");
      if (workerHeaders) {
        const secured = await handleDoctorcreRequest(new Request(`https://doctorcre.com${url.pathname}`), { CARR: { fetch: async () => new Response('synthetic gate') }, ASSETS: { fetch: async () => new Response('synthetic asset') } });
        for (const header of ['content-security-policy', 'permissions-policy', 'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy']) response.setHeader(header, secured.headers.get(header));
      }
      const content = await readFile(new URL(file, root));
      response.end(basemap && file === 'tours/day.js' ? content.toString().replace('mountTourDay({ document, window });',
        'mountTourDay({ document, window, mapFactory: (root, options) => mountAcceptedItinerary(root, { ...options, basemapStyle: { version: 8, sources: {}, layers: [] } }) });') : content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
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
  return { page, context, requests, errors, current, origin, setActor(value) { actor = value; }, refuse() { refuse = true; }, failConnection(session, shell) { sessionFailure = session; shellFailure = shell; } };
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
  await mkdir(new URL("out/test-artifacts/w16/", root), { recursive: true });
  for (const width of [1440, 761, 760, 721, 390, 320]) await t.test(String(width), async t => {
    const { page, requests, errors } = await open(t, { width });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('body.has-app-layout').waitFor();
    assert.equal(await page.locator('#appMainSlot #tour-day').count(), 1, 'Tour day belongs in the workspace main region');
    const record = await page.locator("#day-record").boundingBox();
    const status = await page.locator(width <= 760 ? '#appShell' : '.app-layout-status').boundingBox();
    assert.ok(record.width >= 140 && record.height >= 60 && record.y + record.height < status.y,
      JSON.stringify({record,status,width}));
    const dock = await page.locator('.capture-dock').boundingBox();
    const docPresence = await page.locator(width <= 760 ? '#selfAvatar' : '#docPresence').boundingBox();
    assert.ok(dock.x + dock.width <= docPresence.x || docPresence.x + docPresence.width <= dock.x ||
      dock.y + dock.height <= docPresence.y || docPresence.y + docPresence.height <= dock.y,
      `Capture and Doc must not overlap: ${JSON.stringify({ dock, docPresence, width })}`);
    for (const id of ['day-record', 'day-previous', 'day-next', width <= 760 ? 'selfAvatar' : 'docOpen']) assert.equal(await page.locator('#' + id).evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, `The shared shell must leave ${id} reachable`);
    if (width <= 760) {
      await page.locator('#selfAvatar').click();
      await page.locator('#docOpen').click();
      assert.equal(await page.locator('#docDetail').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#selfAvatar').evaluate(button => document.activeElement === button), true);
    }
    assert.equal(await page.locator(".day-stop").count(), 2);
    assert.match(await page.locator("#day-current").textContent(), /100 Example Way.*Demo listing contact.*West entrance/s);
    assert.equal(await page.locator(".property-actions a").getAttribute("href"), "tel:+12025550100");
    const lastStop = page.locator(".day-stop").nth(1);
    await lastStop.evaluate(button => button.scrollIntoView({ block: 'end' }));
    assert.equal(await lastStop.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, `The last tour stop must scroll clear of fixed controls at ${width}px`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".day-stop").nth(1).click();
    assert.equal(await page.locator("#day-dialog").isVisible(), true);
    const dialog = await page.locator("#day-dialog").boundingBox(); assert.ok(dialog.width >= Math.min(1000, width - 24));
    assert.match(await page.locator("#day-dialog-body").textContent(), /200 Example Way.*north lobby/s);
    if ([1440, 390, 320].includes(width)) await page.screenshot({ path: new URL(`out/test-artifacts/w16/details-${width}.png`, root).pathname, fullPage: true });
    await page.getByLabel("Close property", { exact: true }).click();
    await page.locator("#day-previous").click();
    assert.match(await page.locator("#day-current").textContent(), /waterfront/);
    assert.equal(await page.locator("#day-record").evaluate(e => getComputedStyle(e).animationName), "none");
    assert.equal(await page.locator(".day-stop").first().evaluate(e => getComputedStyle(e).transitionDuration), "0s");
    const copy = await page.locator("#tour-day").textContent(); assert.doesNotMatch(copy, /record layer|source|Read again|retry read|records read|Search Mode/i);
    await page.evaluate(() => window.scrollTo(0, 0));
    if ([1440, 390, 320].includes(width)) await page.screenshot({ path: new URL(`out/test-artifacts/w16/day-${width}.png`, root).pathname, fullPage: true });
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
  await page.screenshot({ path: new URL("out/test-artifacts/w16/phone-note-details.png", root).pathname, fullPage: true });
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
  await page.waitForURL('**/public-shell/session-ended.html');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('doctorcre-tour-day-session-v1')),null);
  await context.setOffline(true); await page.goto(`${origin}/tours/day.html?tour=${tourId}`).catch(()=>null);
  assert.equal(await page.locator('.note-card,.day-stop,#day-record').count(),0);
  assert.doesNotMatch(await page.locator('body').textContent(),/Synthetic tour/);
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

test('R10: ordered list and dock share one restored selection', async t => {
  const { page } = await open(t);
  await page.locator('.day-stop[data-stop-id="66666666-6666-4666-8666-666666666666"]').click();
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
  assert.ok(cached.includes('/js/routes.js'));
  assert.ok(cached.includes('/js/navigation.js'));
  assert.equal(cached.some(path => path.startsWith("/api/")), false);
  await context.setOffline(true); await page.reload();
  await page.waitForFunction(() => document.querySelector("#day-status")?.textContent.includes("Offline"));
  assert.equal(await page.locator(".day-stop").count(), 2); assert.equal(await page.locator(".note-card").count(), 1);
  assert.equal(await page.locator("#appMainSlot #tour-day").count(), 1);
  assert.equal(await page.getByLabel("Workspace sidebar", { exact: true }).isVisible(), false);
  await page.screenshot({ path: new URL("out/test-artifacts/w16/phone-offline.png", root).pathname, fullPage: true });
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector("#day-status").textContent === "Voice notes stay on this phone");
  assert.equal(await page.locator(".note-card").count(), 1); assert.deepEqual(errors, []);
});

test('saved tour survives HTTP-cache eviction, failed shell responses and an online session timeout', async t => {
  const { page, context, failConnection, refuse } = await open(t);
  await page.waitForFunction(() => document.querySelector('#day-offline').textContent === 'Available offline');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const devtools = await context.newCDPSession(page);
  await devtools.send('Network.clearBrowserCache');
  for (const failure of [503, 'hang']) {
    failConnection(failure, true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#day-status')?.textContent.includes('Offline'), null, { timeout: 5_000 });
    assert.equal(await page.evaluate(() => navigator.onLine), true);
    assert.equal(await page.locator('.day-stop').count(), 2);
    assert.match(await page.locator('#day-updated').textContent(), /Saved/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim().length > 0), true);
  }
  failConnection(null, false); refuse();
  await page.locator('#day-refresh').click();
  await page.waitForFunction(() => document.querySelector('#day-status').textContent === 'Sign in to continue');
  assert.equal(await page.locator('.day-stop').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre-tour-day-session-v1')), null);
});

test('revoked shell cache can reopen online and becomes ready only after its files are restored', async t => {
  const { page, origin } = await open(t);
  await page.waitForFunction(() => document.querySelector('#day-offline').textContent === 'Available offline');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.evaluate(async () => {
    const { offlineTourSession } = await import('/js/offline-tour-session.js');
    await offlineTourSession(window).revoke();
  });
  await page.goto(`${origin}/tours/day.html?tour=${tourId}`);
  await page.waitForFunction(() => document.querySelector('#day-offline')?.textContent === 'Available offline', null, { timeout: 8_000 });
  const missing = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('doctorcre-tour-day-shell-'));
    const cached = await caches.open(names[0]);
    return !await cached.match('/css/tokens.css');
  });
  assert.equal(missing, false);
  assert.equal(await page.locator('.day-stop').count(), 2);
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

test("accepted Tour exposes an unlocated stop without offering coordinate navigation", async t => {
  const fixture = structuredClone(detail);
  fixture.routes[0].stops[1].position = null;
  const { page } = await open(t, { fixture, basemap: true });
  await page.locator('.day-stop').nth(1).click();
  await page.getByLabel("Close property", { exact: true }).click();
  assert.match(await page.locator('.day-stop').nth(1).textContent(), /Location unknown/);
  assert.match(await page.locator('#day-current').textContent(), /Location unknown/);
  assert.equal(await page.locator('#day-current a[href*="maps"]').count(), 0);
  assert.equal(await page.locator('.itinerary-pin').count(), 1);
});

function parityFixture() {
  const fixture = structuredClone(detail), route = fixture.routes[0];
  const [first, second] = route.stops;
  const unlocated = { ...second, id: "88888888-8888-4888-8888-888888888888", property_id: "99999999-9999-4999-8999-999999999999", property_name: "Demo unlocated office", property_address: "300 Example Way", position: null, route_sequence: 3, route_label: "3" };
  first.route_label = "1"; second.route_label = "2";
  route.stops = [unlocated, second, first];
  Object.assign(fixture, { projection_id: "synthetic-parity-v1", canonical_dataset_version: "synthetic-v1", component_registry_version: "map-v1" });
  fixture.map_promotion_receipt = { ...structuredClone(mapReceipt), tour_id: fixture.id, route_version_id: route.id, route_version: 1, projection_id: fixture.projection_id };
  fixture.routes.unshift({ ...structuredClone(route), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", accepted: false, route_version: 2, stops: [] });
  return fixture;
}

test("accepted Tour keeps itinerary, numbered markers, next stop and phone handoff aligned across reload and reorder", async t => {
  for (const width of [1440, 390]) await t.test(String(width), async t => {
    const { page, current, errors, requests } = await open(t, { width, fixture: parityFixture(), workerHeaders: true, basemap: true });
    const first = "44444444-4444-4444-8444-444444444444", second = "66666666-6666-4666-8666-666666666666", unknown = "88888888-8888-4888-8888-888888888888";
    const names = { [first]: 'Demo waterfront office', [second]: 'Demo garden suites', [unknown]: 'Demo unlocated office' };
    const currentIs = async (id, coordinate) => {
      assert.equal(await page.locator('.day-stop[aria-current="step"]').getAttribute('data-stop-id'), id);
      assert.equal(await page.locator('#day-current h2').textContent(), names[id]);
      assert.match(await page.locator('.day-stop[aria-current="step"]').textContent(), new RegExp(names[id]));
      if (coordinate) {
        assert.equal(await page.locator(`.itinerary-pin[data-route-stop-id="${id}"]`).getAttribute('aria-pressed'), 'true');
        const links = await page.locator('#day-current a[href*="maps"]').evaluateAll(links => links.map(link => link.href));
        assert.deepEqual(links, [
          `https://www.google.com/maps/dir/?api=1&destination=${coordinate}&travelmode=driving`,
          `https://maps.apple.com/?daddr=${coordinate}&dirflg=d`,
        ]);
      } else {
        assert.match(await page.locator('#day-current').textContent(), /Location unknown/);
        assert.equal(await page.locator('#day-current a[href*="maps"]').count(), 0);
        assert.equal(await page.locator(`.itinerary-pin[data-route-stop-id="${id}"]`).count(), 0);
      }
    };
    const orderIs = async ids => {
      await page.waitForFunction(() => document.querySelectorAll('.itinerary-pin').length === 2);
      assert.deepEqual(await page.locator('.day-stop').evaluateAll(rows => rows.map(row => row.dataset.stopId)), ids);
      assert.deepEqual(await page.locator('.stop-letter').allTextContents(), ['1', '2', '3']);
      assert.deepEqual(await page.locator('.day-stop strong').allTextContents(), ids.map(id => names[id]));
      for (let index = 0; index < 2; index++) {
        const marker = page.locator(`.itinerary-pin[data-route-stop-id="${ids[index]}"]`);
        assert.equal(await marker.locator('span').textContent(), String(index + 1));
        assert.match(await marker.getAttribute('aria-label'), new RegExp(`Stop ${index + 1}, ${names[ids[index]]}`));
      }
      assert.match(await page.locator('.day-stop').nth(2).textContent(), /Location unknown/);
    };
    await orderIs([first, second, unknown]);
    await currentIs(first, '30.6001,-88.0001');
    await page.locator('#day-next').click();
    await currentIs(second, '30.6102,-88.0102');
    await page.evaluate(() => document.addEventListener('click', event => {
      if (event.target.closest('a[href*="maps"]')) event.preventDefault();
    }, true));
    await page.locator('#day-current a[href*="google"]').click();
    await page.reload();
    await orderIs([first, second, unknown]);
    await currentIs(second, '30.6102,-88.0102');
    await page.locator(`.itinerary-pin[data-route-stop-id="${first}"]`).click();
    await currentIs(first, '30.6001,-88.0001');
    await page.locator('.day-stop').nth(1).click();
    assert.equal(await page.locator('#day-dialog-title').textContent(), names[second]);
    await page.getByLabel('Close property', { exact: true }).click();
    await currentIs(second, '30.6102,-88.0102');
    await page.locator('#day-next').click();
    await currentIs(unknown);
    assert.equal(await page.locator('#day-next').isDisabled(), true);
    await page.reload();
    await orderIs([first, second, unknown]);
    await currentIs(unknown);

    const route = current.routes.find(route => route.accepted);
    const a = route.stops.find(stop => stop.id === first), b = route.stops.find(stop => stop.id === second);
    a.route_sequence = 2; a.route_label = '2'; b.route_sequence = 1; b.route_label = '1';
    route.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; route.route_version = 3;
    current.projection_id = 'synthetic-parity-v3';
    await page.locator('#day-refresh').click();
    await page.waitForFunction(() => document.querySelector('.day-stop')?.dataset.stopId === '66666666-6666-4666-8666-666666666666');
    await orderIs([second, first, unknown]);
    assert.equal(await page.locator('#day-current a[href*="maps"]').count(), 0, 'old promotion cannot authorize a reordered route');
    Object.assign(current.map_promotion_receipt, { route_version: 3, route_version_id: route.id, projection_id: current.projection_id });
    await page.locator('#day-refresh').click();
    await page.waitForFunction(() => document.querySelector('#day-current a[href*="maps"]'));
    await currentIs(second, '30.6102,-88.0102');
    await page.locator('#day-next').click();
    await currentIs(first, '30.6001,-88.0001');
    await page.reload();
    await orderIs([second, first, unknown]);
    await currentIs(first, '30.6001,-88.0001');
    await page.locator(`.itinerary-pin[data-route-stop-id="${second}"]`).click();
    await currentIs(second, '30.6102,-88.0102');
    await page.locator('.day-stop').nth(2).click();
    assert.equal(await page.locator('#day-dialog-title').textContent(), names[unknown]);
    await page.getByLabel('Close property', { exact: true }).click();
    await currentIs(unknown);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(request => request.path.startsWith('/api/') && request.method !== 'GET').length, 0);
    if (process.env.TOUR_PARITY_SCREENSHOTS) {
      await mkdir(process.env.TOUR_PARITY_SCREENSHOTS, { recursive: true });
      const capture = async name => {
        await page.evaluate(() => {
          for (const overlay of document.querySelectorAll('#appShell, .app-layout-tabbar, .app-layout-status, .capture-dock')) overlay.style.visibility = 'hidden';
          window.scrollTo(0, 0);
        });
        await page.screenshot({ path: `${process.env.TOUR_PARITY_SCREENSHOTS}/tour-${name}-${width}.png`, fullPage: true });
        await page.evaluate(() => {
          for (const overlay of document.querySelectorAll('#appShell, .app-layout-tabbar, .app-layout-status, .capture-dock')) overlay.style.removeProperty('visibility');
        });
      };
      await capture('parity');
      await page.locator('#day-previous').click();
      await currentIs(first, '30.6001,-88.0001');
      await capture('navigation');
    }
  });
});
