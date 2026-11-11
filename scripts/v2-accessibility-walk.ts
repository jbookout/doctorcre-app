import type { Page } from "playwright";
import { inspectPhoneAccessibility } from "./phone-accessibility.ts";

export async function walkV2Accessibility(page: Page, origin: string, capture: (name: string) => Promise<void>) {
  const results: ({ name: string } & Awaited<ReturnType<typeof inspectPhoneAccessibility>>)[] = [];
  const inspect = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    const result = { name, ...(await inspectPhoneAccessibility(page)) };
    await capture(name);
    results.push(result);
  };
  for (const [name, path, ready] of [
    ["Home", "/", ".inbox-row"],
    ["Deals board", "/deals", ".kanban-card .card-open:visible"],
    ["Tours library", "/tours", ".tour-button"],
    ["Vendors Suggested", "/vendors", "#recordList > li"],
    ["Relationships", "/relationships", "#networkRefresh"],
    ["Leads", "/leads", ".lead-card"],
  ] satisfies [string, string, string][]) {
    await page.goto(new URL(path, origin).href);
    await page.locator(ready).first().waitFor({ state: "visible", timeout: 10000 });
    if (name === "Vendors Suggested") {
      const region = page.getByRole("region", { name: "People worth meeting" });
      const details = page.locator(".vendor-meetings");
      if (!(await details.evaluate((node) => node instanceof HTMLDetailsElement && node.open)))
        await details.locator(":scope > summary").click();
      await region.getByRole("tab", { name: "Suggested", exact: true }).waitFor();
      await region.getByText("Loading people…", { exact: true }).waitFor({ state: "hidden" });
    }
    await inspect(name);
    if (name === "Vendors Suggested") {
      await page.getByRole("tab", { name: "Research", exact: true }).click();
      await page.getByText("Loading people…", { exact: true }).waitFor({ state: "hidden" });
      await inspect("Vendors Research");
    }
    if (name === "Deals board") {
      await page.locator(".kanban-card .card-open:visible").first().click();
      await page.locator("#detailUpdateForm").waitFor({ state: "visible" });
      await inspect("Deal");
    }
    if (name === "Tours library") {
      await page.goto(new URL("/tours/route-editor.html", origin).href);
      await page.locator(".tour-button").first().click();
      await page
        .locator("#tour-panel")
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(async (error) => {
          throw new Error(`${error.message} ${await page.locator("#status").textContent()}`);
        });
      const sheet = page.locator("#internal-cheat-sheet");
      if (!(await sheet.evaluate((node) => node instanceof HTMLDetailsElement && node.open)))
        await sheet.locator(":scope > summary").click();
      await page.locator("#cheat-content").waitFor({ state: "visible" });
      await inspect("Tour and cheat sheet");
    }
  }
  return results;
}
