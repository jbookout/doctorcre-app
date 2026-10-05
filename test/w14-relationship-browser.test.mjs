import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { animationsSettled, chromium, waitForAsync } from "./browser-harness.mjs";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
const root = new URL("../", import.meta.url);
async function open(t, width = 1440) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 1000 },
  });
  await page.clock.install({ time: new Date() });
  const errors = [],
    verbs = [];
  let mode = "ok",
    version = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (r) => {
    const url = new URL(r.request().url());
    if (url.origin !== "http://localhost") return r.abort();
    if (url.pathname === "/api/v1/business/relationships") {
      if (mode === "auth")
        return r.fulfill({
          status: 401,
          json: { error: "AUTHENTICATION_REQUIRED" },
        });
      if (mode === "fail")
        return r.fulfill({
          status: 503,
          json: { error: "DEPENDENCY_UNAVAILABLE" },
        });
      const payload = relationshipNetworkFixture(
        await page.evaluate(() => new Date().toISOString()),
      );
      if (version) payload.nodes[0].summary = "Demo refreshed summary";
      if (mode === "malformed") payload.edges[0].from = "missing";
      if (mode === "territory") payload.nodes[0].territory = 123;
      return r.fulfill({ json: payload });
    }
    if (url.pathname === "/api/system-work/session")
      return r.fulfill({ json: { actor: { slug: "joe" } } });
    if (url.pathname === "/mcp") {
      const verb = r.request().postDataJSON().params.name;
      verbs.push(verb);
      let payload = { ok: true };
      if (verb === "deal-room-board") payload = { deals: [], actor: "joe" };
      if (verb === "today-triage") payload = { items: [] };
      if (verb === "deal-room-changes") payload = { events: [], cursor: null };
      return r.fulfill({
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        },
      });
    }
    if (url.pathname.startsWith("/api/")) return r.fulfill({ json: {} });
    const file =
      url.pathname === "/"
        ? "workspace.html"
        : url.pathname === "/relationships"
          ? "relationships.html"
          : url.pathname.slice(1);
    try {
      return r.fulfill({
        body: await readFile(new URL(file, root)),
        contentType: /\.m?js$/.test(file)
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".json")
              ? "application/json"
              : "text/html",
      });
    } catch {
      return r.fulfill({ status: 404, body: "" });
    }
  });
  await mkdir(new URL("out/test-artifacts/w14", root), { recursive: true });
  return {
    page,
    errors,
    verbs,
    setMode: (v) => {
      mode = v;
    },
    setVersion: (v) => {
      version = v;
    },
  };
}
async function dragLender(page) {
  // Let the shared harness finish layout motion and retry false samples.
  await animationsSettled(page);
  await waitForAsync(
    page,
    () =>
      new Promise((resolve) => {
        const read = () => {
          const r = document
            .querySelector('[data-node="party:demo-lender"]')
            .getBoundingClientRect();
          return `${document.querySelector("#networkScene").getAttribute("transform")} ${r.x} ${r.y} ${r.width} ${r.height}`;
        };
        const first = read();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(read() === first)),
        );
      }),
  );
  const dragged = page.locator('[data-node="party:demo-lender"]').first();
  const box = await dragged.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 25, { steps: 4 });
  await page.mouse.up();
}

for (const width of [1440, 390])
  test(`W14 graph, referrals and evidence popup at ${width}px`, async (t) => {
    const h = await open(t, width),
      { page } = h;
    await page.goto("http://localhost/relationships?mode=live");
    await page.waitForSelector(".relationship-node");
    await page.waitForSelector("#appTabsSlot #graphTab");
    assert.equal(await page.locator("#appLayout").count(), 1);
    assert.equal(await page.locator("#appTabsSlot #graphTab").count(), 1);
    assert.equal(
      await page.locator("#appSidebarSlot #networkSearch").count(),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/network-${width}.png`,
      animations: "disabled",
    });
    await page.locator('[data-node="party:demo-lender"]').first().focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".relationship-dialog[open]");
    assert.match(
      await page.locator(".relationship-dialog").innerText(),
      /Deals sent|Can introduce/,
    );
    assert.ok(
      (await page.locator(".relationship-dialog").boundingBox()).width >
        width * 0.75,
    );
    await page
      .locator('.relationship-dialog details[data-entry="demo-offer"] summary')
      .click();
    assert.match(
      await page.locator(".relationship-dialog details[open]").innerText(),
      /Original synthetic email/,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/detail-${width}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".relationship-dialog").isVisible(), false);
    assert.match(
      await page.evaluate(() =>
        document.activeElement.getAttribute("aria-label"),
      ),
      /Demo Healthcare Lending/,
    );
    await page.locator("#referralsTab").click();
    assert.equal(await page.locator(".relationship-referral").count(), 2);
    assert.match(
      await page.locator("#networkReferrals").innerText(),
      /100% win rate/,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/referrals-${width}.png`,
      animations: "disabled",
    });
    if (width === 390) await page.locator("#appSidebarToggle").click();
    await page.locator("#networkTerritory").selectOption("Demo Inland");
    assert.equal(await page.locator(".relationship-referral").count(), 0);
    await page.locator("#networkReset").click();
    assert.equal(await page.locator(".relationship-referral").count(), 2);
    assert.deepEqual(h.errors, []);
    assert.ok(
      h.verbs.every((v) =>
        [
          "deal-room-board",
          "morning-brief",
          "today-triage",
          "deal-room-changes",
          "unread-count",
          "correspondence-readiness",
          "list-feature-switches","list-doc-suggestions",
        ].includes(v),
      ),
    );
  });
test("W14 autonomous refresh retains filters and expanded evidence, recovers failure and clears auth", async (t) => {
  const h = await open(t),
    { page } = h;
  await page.goto("http://localhost/relationships?mode=live");
  await page.waitForSelector(".relationship-node");
  await page.locator("#networkSearch").fill("Lending");
  assert.equal(await page.locator("#networkNodes button").count(), 1);
  await page.locator("#networkNodes button").click();
  await page.locator(".relationship-dialog summary").first().click();
  h.setVersion(1);
  await page.clock.fastForward(31000);
  await page.waitForFunction(() =>
    document
      .querySelector(".relationship-dialog")
      .textContent.includes("Demo refreshed summary"),
  );
  assert.equal(
    await page
      .locator(".relationship-dialog details")
      .first()
      .getAttribute("open"),
    "",
  );
  assert.equal(await page.locator("#networkSearch").inputValue(), "Lending");
  h.setMode("fail");
  await page.clock.fastForward(61000);
  await page.waitForFunction(() =>
    document
      .querySelector("#networkNotice")
      .textContent.includes("unavailable"),
  );
  assert.equal(await page.locator(".relationship-node").count(), 0);
  assert.equal(await page.locator(".relationship-dialog").isVisible(), false);
  h.setMode("ok");
  await page.clock.fastForward(31000);
  await page.waitForSelector(".relationship-node");
  assert.equal(await page.locator("#networkSearch").inputValue(), "Lending");
  h.setMode("auth");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector("#networkNotice a");
  assert.equal(await page.locator(".relationship-node").count(), 0);
  assert.deepEqual(h.errors, []);
});
test("W14 malformed data, zoom fit and measured reduced motion", async (t) => {
  const h = await open(t),
    { page } = h;
  h.setMode("malformed");
  await page.goto("http://localhost/relationships?mode=live");
  await page.waitForFunction(() =>
    document
      .querySelector("#networkNotice")
      .textContent.includes("unavailable"),
  );
  assert.equal(await page.locator(".relationship-node").count(), 0);
  h.setMode("ok");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector(".relationship-node");
  await page.locator("#networkZoomIn").click();
  assert.match(
    await page.locator("#networkScene").getAttribute("transform"),
    /scale\(1.2\)/,
  );
  await page.locator("#networkFit").click();
  assert.match(
    await page.locator("#networkScene").getAttribute("transform"),
    /scale\(1\)/,
  );
  const dragged = page.locator('[data-node="party:demo-lender"]').first();
  const before = await dragged.getAttribute('transform');
  await dragLender(page);
  assert.notEqual(await dragged.getAttribute('transform'), before);
  assert.equal(await page.locator('.relationship-dialog').isVisible(), false);
  assert.ok(
    await page
      .locator(".network-halo")
      .evaluate((n) => getComputedStyle(n).animationName !== "none"),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".network-halo")
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  assert.equal(
    await page
      .locator(".relationship-node rect")
      .first()
      .evaluate((n) => getComputedStyle(n).transitionDuration),
    "0s",
  );
  assert.equal(await page.locator(".relationship-node").count(), 8);
  assert.deepEqual(h.errors, []);
});
for (const width of [1440, 390])
  test(`W14 Home shares reason and opens card at ${width}px`, async (t) => {
    const h = await open(t, width),
      { page } = h;
    await page.goto("http://localhost/?mode=live");
    await page.waitForSelector("#homeIntroductions [data-intro-node]");
    assert.match(
      await page.locator("#homeIntroductions").innerText(),
      /Worked together on equipment financing/,
    );
    await page.locator("#homeIntroductions button").click();
    assert.match(
      await page.locator("#relationshipTitle").innerText(),
      /Demo Dental Expansion/,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/home-introduction-${width}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    h.setMode("fail");
    await page.clock.runFor(61000);
    await page.waitForFunction(() => document.querySelector('#homeIntroductions').hidden);
    assert.equal(await page.locator('.relationship-dialog').isVisible(), false);
    h.setMode("ok");
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector('#homeIntroductions [data-intro-node]');
    assert.deepEqual(h.errors, []);
  });

test('R2 relationship URL filters survive boot and intentional reset survives polling and reload',async t=>{
 const h=await open(t),{page}=h;await page.goto('http://localhost/relationships?mode=live&territory=Demo+Coast&vertical=dental');await page.waitForSelector('.relationship-node');
 assert.equal(new URL(page.url()).searchParams.get('territory'),'Demo Coast');assert.equal(new URL(page.url()).searchParams.get('vertical'),'dental');
 assert.equal(await page.locator('#networkTerritory').inputValue(),'Demo Coast');const polled=page.waitForResponse('**/api/v1/business/relationships*');await page.locator('#networkReset').click();await page.clock.fastForward(31000);
 await polled;await page.waitForFunction(()=>document.querySelector('#networkRefresh').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#networkTerritory').inputValue(),'');assert.equal(await page.locator('#networkVertical').inputValue(),'');assert.equal(new URL(page.url()).searchParams.has('territory'),false);
 await page.reload();await page.waitForSelector('.relationship-node');assert.equal(await page.locator('#networkTerritory').inputValue(),'');assert.equal(await page.locator('.relationship-node').count(),8);assert.deepEqual(h.errors,[]);
});
for(const failure of ['auth','expiry']) test(`R6 ${failure} invalidates relationship detail DOM facets counts and controls`,async t=>{
 const h=await open(t),{page}=h;await page.goto('http://localhost/relationships?mode=live');await page.waitForSelector('.relationship-node');await page.locator('.relationship-node').first().click();
 h.setMode(failure==='auth'?'auth':'fail');await page.clock.fastForward(failure==='auth'?31000:61000);await page.waitForFunction(()=>document.querySelector('#networkNotice').textContent.includes('Sign in')||document.querySelector('#networkNotice').textContent.includes('unavailable'));
 assert.equal(await page.locator('.relationship-dialog').textContent(),'');assert.equal(await page.locator('#networkTerritory option').count(),1);assert.equal(await page.locator('#networkVertical option').count(),1);
 assert.equal(await page.locator('#networkCount').textContent(),'');assert.equal(await page.locator('#networkMore').isVisible(),false);assert.equal(await page.locator('#networkZoomIn').isDisabled(),true);assert.deepEqual(h.errors,[]);
});
test('R7 malformed optional field is rejected without poisoning retained snapshot or later interactions',async t=>{
 const h=await open(t),{page}=h;await page.goto('http://localhost/relationships?mode=live');await page.waitForSelector('.relationship-node');
 const before=await page.locator('#networkCanvas').textContent();h.setMode('territory');await page.clock.fastForward(31000);await page.waitForFunction(()=>!document.querySelector('#networkNotice').hidden);
 assert.equal(await page.locator('#networkCanvas').textContent(),before);await page.locator('#networkReset').click();await page.setViewportSize({width:1000,height:900});await page.locator('#networkZoomIn').click();assert.deepEqual(h.errors,[]);
 assert.equal(await page.locator('.relationship-node').count(),8);assert.equal(await page.locator('#networkUpdated').isVisible(),true);
});

test("W14 drag stays pending during graph resizing and uses the settled center", async (t) => {
  const browser = await chromium.launch();
  let dragging;
  // Drain input before closing its page, including on assertion failure.
  t.after(async () => {
    try { await dragging; } finally { await browser.close(); }
  });
  const page = await browser.newPage();
  await page.clock.install({ time: new Date() });
  await page.setContent(`
    <style>
      #canvas { width: 820px; transition: width 2s linear; }
      svg { display: block; width: 100%; height: 200px; }
    </style>
    <div id="canvas"><svg viewBox="0 0 820 200">
      <g id="networkScene" transform="translate(0 0)">
        <rect data-node="party:demo-lender" x="300" y="50" width="100" height="100" />
      </g>
    </svg></div>
  `);
  await page.evaluate(() => {
    window.dragInputs = [];
    document.querySelector('[data-node="party:demo-lender"]').addEventListener("pointerdown", event => {
      window.dragInputs.push({ x: event.clientX, y: event.clientY, width: document.querySelector("#canvas").getBoundingClientRect().width });
    });
    document.querySelector("#canvas").getBoundingClientRect();
    document.querySelector("#canvas").style.width = "320px";
  });
  await page.waitForFunction(() => document.getAnimations().some(animation => animation.playState === "running"));
  let completed = false;
  dragging = dragLender(page).then(() => { completed = true; });
  await delay(150);
  assert.equal(completed, false, "drag must stay pending while the target is moving");
  assert.deepEqual(await page.evaluate(() => window.dragInputs), [], "no input before geometry settles");
  await dragging;
  const box = await page.locator('[data-node="party:demo-lender"]').boundingBox();
  const inputs = await page.evaluate(() => window.dragInputs);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].width, 320, "measure only after the resize finishes");
  assert.ok(Math.abs(inputs[0].x - (box.x + box.width / 2)) <= 1);
  assert.ok(Math.abs(inputs[0].y - (box.y + box.height / 2)) <= 1);
});
