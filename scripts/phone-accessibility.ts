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
  type TapCandidate = {
    element: Element;
    sources: ("accessibility" | "listener" | "native")[];
    reachable: boolean;
    box: { width: number; height: number };
  };
  async function measureTargets(this: Map<Element, TapCandidate>) {
    const parent = (node: Element): Element | null => {
      const root = node.getRootNode();
      return node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    };
    const hasInertAncestor = (node: Element): boolean => {
      for (let current: Element | null = node; current; current = parent(current))
        if (current.hasAttribute("inert")) return true;
      return false;
    };
    const contains = (ancestor: Element, child: Element): boolean => {
      for (let current = parent(child); current; current = parent(current)) if (current === ancestor) return true;
      return false;
    };
    const candidates = [...this.values()];
    for (const candidate of candidates) {
      const node = candidate.element;
      const rect = node.getBoundingClientRect();
      candidate.reachable =
        node.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true }) &&
        !hasInertAncestor(node) &&
        !node.matches(":disabled") &&
        rect.width > 0 &&
        rect.height > 0;
      const label =
        node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type)
          ? [...(node.labels || [])].find((label) => label.checkVisibility() && !hasInertAncestor(label))
          : null;
      candidate.box = (label || node).getBoundingClientRect();
    }
    // Delegation routes activation to descendants. A listener-only container is a target only when it has none.
    const targets = candidates.filter(
      (candidate) =>
        candidate.reachable &&
        (candidate.sources.some((source) => source !== "listener") ||
          !candidates.some((other) => other !== candidate && contains(candidate.element, other.element))),
    );
    const undersized = (candidate: TapCandidate) => candidate.box.width < 44 || candidate.box.height < 44;
    const describeTarget = (node: Element) => ({
      tag: node.tagName,
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      minWidth: getComputedStyle(node).minWidth,
      minHeight: getComputedStyle(node).minHeight,
      id: node.id,
      class: node.getAttribute("class") || "",
      text: (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 80),
    });
    const small = targets.filter(undersized).map(({ element }) => describeTarget(element));
    const clipped = targets
      .map(({ element }) => element)
      .filter(
        (node) =>
          node.scrollWidth > node.clientWidth + 2 && ["hidden", "clip"].includes(getComputedStyle(node).overflowX),
      )
      .map(describeTarget);
    const positiveTabindex = [...document.querySelectorAll<HTMLElement>("[tabindex]")]
      .filter((node) => node.tabIndex > 0)
      .map(describeTarget);
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
      expression: "new Map()",
      contextId: executionContextId,
      objectGroup: "phone-accessibility",
    });
    if (!targets.objectId) throw Error("Could not create accessible target collection");
    const targetCollection = targets.objectId;
    async function collect(objectId: string, source: TapCandidate["sources"][number]) {
      const { exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
        objectId: targetCollection,
        functionDeclaration: `function(element, source) {
          if (!(element instanceof Element) || element.ownerDocument !== document) return;
          const candidate = this.get(element);
          if (candidate) { if (!candidate.sources.includes(source)) candidate.sources.push(source); }
          else this.set(element, { element, sources: [source], reachable: false, box: { width: 0, height: 0 } });
        }`,
        arguments: [{ objectId }, { value: source }],
      });
      if (exceptionDetails) throw Error("Could not collect phone tap target");
    }
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const nativeHosts = new Map<number, number>();
    function visit(node: typeof root, nativeHost?: number) {
      if (nativeHost) nativeHosts.set(node.backendNodeId, nativeHost);
      for (const child of node.children || []) visit(child, nativeHost);
      for (const shadow of node.shadowRoots || [])
        visit(shadow, shadow.shadowRootType === "user-agent" ? node.backendNodeId : nativeHost);
      if (node.contentDocument) visit(node.contentDocument);
    }
    visit(root);
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId || !interactiveRoles.has(String(node.role?.value))) continue;
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: nativeHosts.get(node.backendDOMNodeId) || node.backendDOMNodeId,
        executionContextId,
        objectGroup: "phone-accessibility",
      });
      if (!object.objectId) throw Error("Accessible target has no DOM object");
      await collect(object.objectId, "accessibility");
    }
    const { result: elements } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const elements = [];
        const visit = (root) => {
          for (const element of root.querySelectorAll('*')) {
            elements.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);
        return elements;
      })()`,
      contextId: executionContextId,
      objectGroup: "phone-accessibility",
    });
    if (!elements.objectId) throw Error("Could not enumerate phone tap elements");
    const { result: properties } = await cdp.send("Runtime.getProperties", {
      objectId: elements.objectId,
      ownProperties: true,
    });
    const elementIds = properties
      .filter((property) => /^\d+$/.test(property.name))
      .flatMap((property) => (property.value?.objectId ? [property.value.objectId] : []));
    const events = new Set(["click", "pointerdown", "pointerup", "touchstart", "touchend"]);
    // Bound protocol concurrency independently of document size.
    for (let offset = 0; offset < elementIds.length; offset += 16) {
      await Promise.all(
        elementIds.slice(offset, offset + 16).map(async (objectId) => {
          const { node } = await cdp.send("DOM.describeNode", { objectId });
          const { object } = await cdp.send("DOM.resolveNode", {
            backendNodeId: node.backendNodeId,
            objectGroup: "phone-accessibility",
          });
          if (!object.objectId) throw Error("Listener target has no main-world DOM object");
          const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: object.objectId });
          if (listeners.some((listener) => events.has(listener.type))) await collect(objectId, "listener");
          const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function() {
            return this.matches('a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]:not([tabindex="-1"]),label[for]') ||
              (this.matches('label') && !!this.querySelector('input:not([type="hidden"]),select,textarea,button'));
          }`,
            returnByValue: true,
          });
          if (exceptionDetails) throw Error("Could not identify native phone tap element");
          if (result.value) await collect(objectId, "native");
        }),
      );
    }
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: targetCollection,
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
