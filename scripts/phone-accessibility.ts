import { readFile } from "node:fs/promises";
import type { AxeResults } from "axe-core";
import type { Page } from "playwright";

export async function inspectPhoneAccessibility(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const axeSource = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
  await page.route("**/__phone-axe.js", (route) => route.fulfill({ contentType: "text/javascript", body: axeSource }));
  await page.addScriptTag({ url: new URL("/__phone-axe.js", page.url()).href });
  const measurements = await page.evaluate(async () => {
    const visible = (node: Element) => {
      const r = node.getBoundingClientRect();
      return (
        r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && getComputedStyle(node).visibility !== "hidden"
      );
    };
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        "button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab]",
      ),
    ].filter(visible);
    const describe = (node: HTMLElement) => ({
      tag: node.tagName,
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      minWidth: getComputedStyle(node).minWidth,
      minHeight: getComputedStyle(node).minHeight,
      id: node.id,
      class: node.className,
      text: (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 80),
    });
    const small = targets
      .filter((node) => {
        const label =
          node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type) ? node.labels?.[0] : null;
        const r = (label || node).getBoundingClientRect();
        return !node.matches(":disabled") && (r.width < 44 || r.height < 44);
      })
      .map(describe);
    const clipped = targets
      .filter(
        (node) =>
          node.scrollWidth > node.clientWidth + 2 && ["hidden", "clip"].includes(getComputedStyle(node).overflowX),
      )
      .map(describe);
    const positiveTabindex = [...document.querySelectorAll<HTMLElement>("[tabindex]")]
      .filter((node) => node.tabIndex > 0)
      .map(describe);
    // The same-origin script above installs the locked axe runtime on this page.
    const runtime = window as unknown as { axe?: { run(options: unknown): Promise<AxeResults> } };
    if (!runtime.axe) throw Error("axe dependency was not loaded");
    const result = await runtime.axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      small,
      clipped,
      positiveTabindex,
      violations: result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    };
  });
  const focusOrder = [];
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const node = document.activeElement;
      if (!(node instanceof HTMLElement) || node === document.body) return null;
      const style = getComputedStyle(node);
      return {
        name: (node.getAttribute("aria-label") || node.textContent || node.id).trim().slice(0, 80),
        role: node.getAttribute("role") || node.tagName,
        visibleFocus:
          (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none",
      };
    });
    if (!focus) break;
    focusOrder.push(focus);
  }
  return { ...measurements, focusOrder };
}
