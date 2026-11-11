import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "./browser-harness.mjs";

const publication = JSON.parse(readFileSync("test/fixtures/portal/example-health.market-study.json", "utf8"));
const receipt = JSON.parse(readFileSync("contracts/fixtures/portal-proposals.v1.json", "utf8"));
publication.properties = [
  {
    ...publication.properties[0],
    id: receipt.selection.selected[0],
    role: "candidate",
    address: "Synthetic exceptionally long healthcare property name and accessibility entrance address",
  },
];
const css = ["css/tokens.css", "portal/styles.css", "portal/tour-list.css"]
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");
const bundle = await build({
  stdin: {
    contents: `
import { mountMarketStudy, mountPortal } from './src/ui/portal/shell-home-sources';
let receipt = ${JSON.stringify(receipt)};
window.requests = []; window.reads = 0; window.clears = 0;
const options = { package: ${JSON.stringify(publication)}, modules: [{route:'documents', label:'Documents', available:()=>true, render:()=> 'Existing Documents panel'}], proposals: {
scope: {publication_id: receipt.publication_id, publication_version: 1},
transport: {read: async()=> {window.reads++; return receipt;}, save:async(version,request)=> {window.requests.push(request); if(window.failure==='lost') throw Error(); if(window.failure==='conflict') throw {status:409}; receipt={...receipt,selection:{version:request.version+1,selected:request.selected,notes:request.notes}}; return receipt;}},
signOut:async()=>{},clearPrivateState:()=> window.clears++,returnToGate:()=>window.panel.dispose()
}};
window.mount = ()=> {window.panel=mountMarketStudy(document.getElementById('root'),options)};
window.retire = ()=> {options.package.properties=[]; receipt={...receipt,retired:receipt.selection.selected}; window.mount();};
window.publish = ()=> {options.proposals.scope.publication_version=2;receipt={...receipt,publication_version:2,retired:[],selection:{version:0,selected:[],notes:{}}};window.mount();};
window.switchAsync = async()=> {let resolve; const old=mountPortal(document.getElementById('root'),{load:()=>new Promise(done=>resolve=done)}); window.panel=mountPortal(document.getElementById('root'),{load:async()=>options.package,proposals:options.proposals,modules:options.modules});resolve({...options.package,market:{...options.package.market,home_title:'Stale publication'}});await new Promise(done=>queueMicrotask(done));old.dispose();};
window.mount();`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
for (const width of [390, 1440])
  for (const theme of ["light", "dark"])
    test(`proposal host route lifetime, transport, keyboard and retirement ${width} ${theme}`, async (t) => {
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 950 } });
      await page.route("http://localhost/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="en" data-theme="${theme}"><head><title>Proposal host fixture</title><style>${css}</style></head><body><div id="root"></div></body></html>`,
        }),
      );
      await page.goto("http://localhost/portal/#tour-list");
      await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? "" });
      await page.locator('[data-state="ready"]').waitFor();
      assert.equal(await page.getByRole("textbox").inputValue(), "Client note");
      await page.getByRole("textbox").fill("Exact saved note");
      await page.getByRole("navigation").getByRole("link", { name: "Documents", exact: true }).click();
      await page.getByText("Existing Documents panel").waitFor();
      await page.getByRole("navigation").getByRole("link", { name: "Tour List", exact: true }).click();
      assert.equal(await page.getByRole("textbox").inputValue(), "Exact saved note");
      assert.equal(await page.evaluate("window.reads"), 1);
      await page.evaluate('window.failure="lost"');
      await page.getByRole("button", { name: "Save Selections", exact: true }).click();
      await page.locator('[data-state="uncertain"]').waitFor();
      assert.equal(await page.getByRole("textbox").isDisabled(), true);
      mkdirSync("/tmp/WR586.S5.J16-shots", { recursive: true });
      await page.evaluate(() => {
        scrollTo(0, 0);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await page.screenshot({ path: `/tmp/WR586.S5.J16-shots/uncertain-${width}-${theme}.png`, fullPage: true });
      await page.evaluate('window.failure=""');
      await page.getByRole("button", { name: "Retry same save", exact: true }).click();
      await page.locator('[data-state="ready"]').waitFor();
      assert.equal(
        await page.evaluate("JSON.stringify(window.requests[0]) === JSON.stringify(window.requests[1])"),
        true,
      );
      await page.getByRole("button", { name: /^Remove / }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: /^Add / }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: /^Remove / }).click();
      const transfer = await page.evaluateHandle((id) => {
        const data = new DataTransfer();
        data.setData("text/plain", id);
        return data;
      }, receipt.selection.selected[0]);
      await page
        .getByRole("region", { name: "Selected properties", exact: true })
        .dispatchEvent("drop", { dataTransfer: transfer });
      assert.equal(await page.getByRole("textbox").count(), 1);
      await page.evaluate('window.failure="conflict"');
      await page.getByRole("button", { name: "Save Selections", exact: true }).click();
      await page.locator('[data-state="conflict"]').waitFor();
      assert.equal(await page.getByRole("textbox").isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.evaluate(() => {
        scrollTo(0, 0);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await page.screenshot({ path: `/tmp/WR586.S5.J16-shots/conflict-${width}-${theme}.png`, fullPage: true });
      await page.getByRole("button", { name: "Reload Shared List", exact: true }).click();
      await page.getByRole("button", { name: "Discard and reload", exact: true }).click();
      await page.locator('[data-state="ready"]').waitFor();
      await page.getByRole("textbox").fill("Retire this draft");
      await page.evaluate("window.mount()");
      await page.locator('[data-state="ready"]').waitFor();
      assert.equal(await page.getByRole("textbox").inputValue(), "Exact saved note");
      assert.equal(await page.evaluate("window.clears"), 1);
      await page.evaluate("window.switchAsync()");
      await page.locator('[data-state="ready"]').waitFor();
      assert.equal(await page.getByRole("textbox").inputValue(), "Exact saved note");
      await page.evaluate("window.retire()");
      await page.locator('[data-state="ready"]').waitFor();
      assert.equal(await page.getByRole("textbox").inputValue(), "Exact saved note");
      assert.equal(await page.getByRole("textbox").isDisabled(), true);
      await page.evaluate("window.publish()");
      await page.locator('[data-state="ready"]').waitFor();
      assert.equal(await page.getByRole("textbox").count(), 0);
      await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
      assert.equal(await page.getByRole("textbox").count(), 0);
    });
