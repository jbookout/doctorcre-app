import { readFile } from "node:fs/promises";
import { parseExpression } from "@babel/parser";
import type { AxeResults } from "axe-core";
import type { Frame, Page } from "playwright";

export async function inspectPhoneAccessibility(page: Page, frame: Frame = page.mainFrame(), reverse = false) {
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
    sources: ("accessibility" | "listener" | "native" | "delegated")[];
    reachable: boolean;
    box: { width: number; height: number };
  };
  async function measureTargets(this: Map<Element, TapCandidate>, reverse: boolean) {
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
    const elements = new Set(candidates.map(({ element }) => element));
    for (const { element } of candidates)
      if (element instanceof HTMLInputElement) for (const label of element.labels || []) elements.add(label);
    // Expand the document root past every rendered target so viewport position never excludes one.
    const margin =
      Math.ceil(
        [...elements].reduce(
          (extent, element) => {
            const rect = element.getBoundingClientRect();
            return Math.max(
              extent,
              Math.abs(rect.left),
              Math.abs(rect.top),
              Math.abs(rect.right),
              Math.abs(rect.bottom),
            );
          },
          Math.max(innerWidth, innerHeight),
        ),
      ) + 1;
    const boxes = await new Promise<Map<Element, { width: number; height: number }>>((resolve) => {
      const boxes = new Map<Element, { width: number; height: number }>();
      if (!elements.size) {
        resolve(boxes);
        return;
      }
      // Chromium applies overflow, legacy clip and clip-path through the full ancestor chain.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            boxes.set(entry.target, { width: entry.intersectionRect.width, height: entry.intersectionRect.height });
          if (boxes.size === elements.size) {
            observer.disconnect();
            resolve(boxes);
          }
        },
        { root: document, rootMargin: `${margin}px` },
      );
      for (const element of elements) observer.observe(element);
    });
    const clippedBox = (node: Element) => {
      const box = boxes.get(node) || { width: 0, height: 0 };
      if (box.width > 0 && box.height > 0)
        for (let current: Element | null = node; current; current = parent(current)) {
          const clip = getComputedStyle(current).clipPath;
          if (clip !== "none" && (!clip.startsWith("inset(") || clip.includes("round")))
            throw Error(`Phone target needs exact nonrectangular clip-path geometry: ${clip}`);
        }
      return box;
    };
    const visible = (node: Element) =>
      node.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true }) &&
      !hasInertAncestor(node) &&
      !node.matches(":disabled");
    const activationAreas = new Map<Element, Element>();
    for (const candidate of candidates) {
      const node = candidate.element;
      const box = visible(node) ? clippedBox(node) : { width: 0, height: 0 };
      candidate.reachable = box.width > 0 && box.height > 0;
      const label =
        node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type)
          ? [...(node.labels || [])].find((label) => {
              if (!visible(label)) return false;
              const box = clippedBox(label);
              return box.width > 0 && box.height > 0;
            })
          : null;
      candidate.box = label ? clippedBox(label) : box;
      activationAreas.set(node, label || node);
    }
    const targets = candidates.filter(
      (candidate) =>
        candidate.reachable &&
        (candidate.sources.some((source) => source !== "listener") ||
          !candidates.some(
            (other) => other.reachable && other !== candidate && contains(candidate.element, other.element),
          )),
    );
    const selector = (node: Element): string => {
      if (node.id) {
        const root = node.getRootNode();
        const id = `#${CSS.escape(node.id)}`;
        return root instanceof ShadowRoot ? `${selector(root.host)} >>> ${id}` : id;
      }
      const parent = node.parentElement;
      const position = parent
        ? [...parent.children].filter((child) => child.tagName === node.tagName).indexOf(node) + 1
        : 1;
      const part = `${node.tagName.toLowerCase()}:nth-of-type(${position})`;
      if (parent) return `${selector(parent)} > ${part}`;
      const root = node.getRootNode();
      return root instanceof ShadowRoot ? `${selector(root.host)} >>> ${part}` : part;
    };
    const describeTarget = (node: Element) => ({
      selector: selector(node),
      tag: node.tagName,
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      minWidth: getComputedStyle(node).minWidth,
      minHeight: getComputedStyle(node).minHeight,
      id: node.id,
      class: node.getAttribute("class") || "",
      text: (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 80),
    });
    const measured = (reverse ? [...targets].reverse() : targets).map(({ element, box }) => ({
      description: { ...describeTarget(element), ...box },
      areaSelector: selector(activationAreas.get(element) || element),
    }));
    const findArea = (path: string): Element => {
      let root: Document | ShadowRoot = document;
      const parts = path.split(" >>> ");
      for (const [index, part] of parts.entries()) {
        const node: Element | null = root.querySelector(part);
        if (!node) throw Error(`Phone target changed during inspection: ${path}`);
        if (index === parts.length - 1) return node;
        if (!node.shadowRoot) throw Error(`Phone target shadow root changed: ${path}`);
        root = node.shadowRoot;
      }
      throw Error(`Empty phone target selector: ${path}`);
    };
    const scrollPositions = [...document.querySelectorAll("*")].map((node) => ({
      node,
      left: node.scrollLeft,
      top: node.scrollTop,
    }));
    const restoreScroll = async () => {
      for (const { node, left, top } of scrollPositions)
        if (node.isConnected) node.scrollTo({ left, top, behavior: "instant" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const covered: (ReturnType<typeof describeTarget> & {
      hit: string | null;
      visibleBox: { x: number; y: number; width: number; height: number };
    })[] = [];
    try {
      for (const { description, areaSelector } of measured) {
        await restoreScroll();
        findArea(areaSelector).scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const area = findArea(areaSelector);
        const [size, rect] = await Promise.all(
          [{ root: document, rootMargin: `${margin}px` }, {}].map(
            (options) =>
              new Promise<DOMRectReadOnly>((resolve) => {
                const observer = new IntersectionObserver(([entry]) => {
                  if (!entry) return;
                  observer.disconnect();
                  resolve(entry.intersectionRect);
                }, options);
                observer.observe(area);
              }),
          ),
        );
        if (!size || !rect) throw Error("Phone target geometry unavailable");
        description.width = size.width;
        description.height = size.height;
        let hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        if (!rect.width || !rect.height || !hit || (hit !== area && !contains(area, hit)))
          covered.push({
            ...description,
            hit: hit ? selector(hit) : null,
            visibleBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
      }
    } finally {
      await restoreScroll();
    }
    const small = measured.map(({ description }) => description).filter((box) => box.width < 44 || box.height < 44);
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
      covered,
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
    const analyzeListeners: (() => Promise<void>)[] = [];
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
          const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: `function() {
              const keys = Object.keys(this);
              const props = keys.find(key => key.startsWith('__reactProps$'));
              return {
                native: this.matches('a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]:not([tabindex="-1"]),label[for]') ||
                  (this.matches('label') && !!this.querySelector('input:not([type="hidden"]),select,textarea,button')),
                rendered: this.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true }),
                reactRoot: keys.some(key => key.startsWith('__reactContainer$')),
                reactTarget: props && ['onClick','onPointerDown','onPointerUp','onTouchStart','onTouchEnd'].some(event => typeof this[props][event] === 'function')
              };
            }`,
            returnByValue: true,
          });
          if (exceptionDetails || !result.value) throw Error("Could not identify native phone tap element");
          if (result.value.native) await collect(objectId, "native");
          if (result.value.reactTarget) await collect(objectId, "delegated");
          const activationListeners = listeners.filter((listener) => events.has(listener.type));
          if (activationListeners.length) await collect(objectId, "listener");
          if (activationListeners.length && result.value.rendered)
            analyzeListeners.push(async () => {
              const selectors = new Set<string>();
              const refusals: string[] = [];
              for (const listener of activationListeners) {
                const listenerSelectors = new Set<string>();
                const source = listener.handler?.description;
                if (!source) throw Error("Phone delegation needs inspectable listener source");
                const field = (value: unknown, key: string): unknown =>
                  value && typeof value === "object" ? Reflect.get(value, key) : undefined;
                const expression = parseExpression(source);
                const parameters = field(expression, "params");
                const names = new Set(
                  Array.isArray(parameters) ? parameters.map((parameter) => field(parameter, "name")) : [],
                );
                const frameworkRoot = result.value.reactRoot && names.size > 1;
                const aliases = new Set<string>();
                let readsTarget = false;
                const visit = (value: unknown, parent?: unknown, grandparent?: unknown) => {
                  if (!value || typeof value !== "object") return;
                  if (Array.isArray(value)) {
                    for (const child of value) visit(child, parent, grandparent);
                    return;
                  }
                  const type = field(value, "type");
                  if (type === "Identifier" && aliases.has(String(field(value, "name")))) {
                    const parentProperty = field(parent, "property");
                    const method = field(parentProperty, "name") || field(parentProperty, "value");
                    const declaration = field(parent, "type") === "VariableDeclarator" && field(parent, "id") === value;
                    const propertyName = field(parent, "property") === value && !field(parent, "computed");
                    const narrowed =
                      field(parent, "type") === "BinaryExpression" && field(parent, "operator") === "instanceof";
                    if (!declaration && !propertyName && !narrowed && method !== "closest" && method !== "matches")
                      refusals.push("Phone delegation has unknown aliased target dispatch semantics");
                  }
                  const property = field(value, "property");
                  const propertyName = field(property, "name") || field(property, "value");
                  if (
                    (type === "MemberExpression" || type === "OptionalMemberExpression") &&
                    ["target", "srcElement", "composedPath"].includes(String(propertyName))
                  ) {
                    readsTarget = true;
                    const parentProperty = field(parent, "property");
                    const method = field(parentProperty, "name") || field(parentProperty, "value");
                    const narrowed =
                      field(parent, "type") === "BinaryExpression" && field(parent, "operator") === "instanceof";
                    const alias =
                      field(parent, "type") === "VariableDeclarator" ? field(field(parent, "id"), "name") : undefined;
                    const datasetKey = method === "dataset" ? field(field(grandparent, "property"), "name") : undefined;
                    if (typeof datasetKey === "string")
                      listenerSelectors.add(
                        `[data-${datasetKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`,
                      );
                    else if (typeof alias === "string") aliases.add(alias);
                    else if (!narrowed && method !== "closest" && method !== "matches")
                      refusals.push(
                        `Phone delegation has unknown target dispatch semantics: ${node.nodeName} ${node.attributes}`,
                      );
                  }
                  if (type === "CallExpression" || type === "OptionalCallExpression") {
                    const argumentsValue = field(value, "arguments");
                    if (
                      !frameworkRoot &&
                      Array.isArray(argumentsValue) &&
                      argumentsValue.some(
                        (argument) => field(argument, "type") === "Identifier" && names.has(field(argument, "name")),
                      )
                    )
                      refusals.push("Phone target dispatch uses an opaque delegated helper");
                    const property = field(field(value, "callee"), "property");
                    const method = field(property, "name") || field(property, "value");
                    if (method === "closest" || method === "matches") {
                      const args = field(value, "arguments");
                      const selector = Array.isArray(args) ? args[0] : undefined;
                      const literal = field(selector, "value");
                      if (field(selector, "type") !== "StringLiteral" || typeof literal !== "string")
                        refusals.push("Phone delegation needs a literal target selector");
                      else listenerSelectors.add(literal);
                    }
                  }
                  for (const child of Object.values(value)) visit(child, value, parent);
                };
                visit(expression);
                if (readsTarget && !listenerSelectors.size)
                  refusals.push("Phone delegation has unknown target dispatch semantics");
                for (const selector of listenerSelectors) selectors.add(selector);
              }
              if (refusals.length) throw Error(refusals[0]);
              if (selectors.size) {
                const { exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
                  objectId: targetCollection,
                  functionDeclaration: `function(owner, selectors) {
                  for (const selector of selectors) for (const element of owner.querySelectorAll(selector)) {
                    const candidate = this.get(element);
                    if (candidate) { if (!candidate.sources.includes("delegated")) candidate.sources.push("delegated"); }
                    else this.set(element, { element, sources: ["delegated"], reachable: false, box: { width: 0, height: 0 } });
                  }
                }`,
                  arguments: [{ objectId }, { value: [...selectors] }],
                });
                if (exceptionDetails) throw Error("Phone delegation target discovery failed");
              }
            });
        }),
      );
    }
    for (const analyze of analyzeListeners) await analyze();
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: targetCollection,
      functionDeclaration: measureTargets.toString(),
      arguments: [{ value: reverse }],
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails || !result.value)
      throw Error(
        `Could not measure accessible DOM targets: ${exceptionDetails?.exception?.description || "no measurements"}`,
      );
    measurements = result.value;
  } finally {
    try {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "phone-accessibility" });
    } finally {
      await cdp.detach();
    }
  }
  return measurements;
}
