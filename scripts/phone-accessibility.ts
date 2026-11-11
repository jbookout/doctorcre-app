import { readFile } from "node:fs/promises";
import type { AxeResults } from "axe-core";
import type { Frame, Page } from "playwright";

export async function inspectPhoneAccessibility(page: Page, frame: Frame = page.mainFrame()) {
  if (page.context().browser()?.browserType().name() !== "chromium")
    throw Error("Phone accessibility inspection requires Chromium's accessibility tree");
  await frame.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const axeSource = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
  async function measureTargets(this: HTMLElement[]) {
    const targets = this.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
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
    // The isolated world contains the locked axe runtime injected below.
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
  }
  const cdp = await page.context().newCDPSession(page);
  let measurements: Awaited<ReturnType<typeof measureTargets>>;
  try {
    let { frameTree } = await cdp.send("Page.getFrameTree");
    const ancestry: Frame[] = [];
    for (let current = frame, parent = current.parentFrame(); parent; current = parent, parent = current.parentFrame())
      ancestry.unshift(current);
    for (const child of ancestry) {
      const index = child.parentFrame()?.childFrames().indexOf(child) ?? -1;
      const subtree = frameTree.childFrames?.[index];
      if (!subtree) throw Error("Inspected frame is absent from Chromium's frame tree");
      frameTree = subtree;
    }
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "phone-accessibility",
    });
    const { nodes } = await cdp.send("Accessibility.getFullAXTree", { frameId: frameTree.frame.id });
    const interactiveRoles = new Set([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "slider",
      "spinbutton",
      "tab",
      "DisclosureTriangle",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "switch",
      "searchbox",
      "treeitem",
    ]);
    await cdp.send("Runtime.evaluate", { expression: axeSource, contextId: executionContextId });
    const { result: targets } = await cdp.send("Runtime.evaluate", {
      expression: "[]",
      contextId: executionContextId,
      objectGroup: "phone-accessibility",
    });
    if (!targets.objectId) throw Error("Could not create accessible target collection");
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId || !interactiveRoles.has(String(node.role?.value))) continue;
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: node.backendDOMNodeId,
        executionContextId,
        objectGroup: "phone-accessibility",
      });
      if (!object.objectId) throw Error("Accessible target has no DOM object");
      const { exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
        objectId: targets.objectId,
        functionDeclaration: `function(target) {
          if (target.ownerDocument !== document) return;
          while (target.getRootNode() instanceof ShadowRoot) target = target.getRootNode().host;
          if (!this.includes(target)) this.push(target);
        }`,
        arguments: [{ objectId: object.objectId }],
      });
      if (exceptionDetails) throw Error("Could not collect accessible DOM target");
    }
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: targets.objectId,
      functionDeclaration: measureTargets.toString(),
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails || !result.value) throw Error("Could not measure accessible DOM targets");
    measurements = result.value;
  } finally {
    try {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "phone-accessibility" });
    } finally {
      await cdp.detach();
    }
  }
  const focusOrder = [];
  await frame.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press("Tab");
    const focus = await frame.evaluate(() => {
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
