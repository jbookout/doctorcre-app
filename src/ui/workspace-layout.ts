export type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>;
export type FloatingPanel = Bounds & Readonly<{ panel: string }>;
export type LayoutNode = Readonly<{
  kind: "tabs"; id: string; panels: readonly [string, ...string[]]; active: string;
}> | Readonly<{
  kind: "split"; id: string; axis: "horizontal" | "vertical"; ratio: number;
  first: LayoutNode; second: LayoutNode;
}>;
export type Layout = Readonly<{
  version: 1; stage: LayoutNode | null;
  floating: readonly FloatingPanel[]; hidden: readonly string[];
}>;
export type Destination = Readonly<
  { kind: "stage"; group: string } |
  { kind: "tabs"; group: string; index?: number } |
  { kind: "split"; target: string; id: string; group: string; axis: "horizontal" | "vertical"; side: "before" | "after"; ratio: number } |
  ({ kind: "floating" } & Bounds) |
  { kind: "hidden" }
>;

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a layout object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a nonempty identifier");
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
  return value;
}

function bounds(value: unknown): Bounds {
  const item = record(value);
  const result = { x: finite(item.x), y: finite(item.y), width: finite(item.width), height: finite(item.height) };
  if (result.width <= 0 || result.height <= 0) throw new Error("Floating dimensions must be positive");
  return result;
}

function ratio(value: unknown): number {
  const result = finite(value);
  if (result <= 0 || result >= 1) throw new Error("Split ratio must be between zero and one");
  return result;
}

export function validateLayout(value: unknown): Layout {
  const layout = record(value);
  if (layout.version !== 1) throw new Error("Unsupported layout version");
  const panelIds = new Set<string>();
  const nodeIds = new Set<string>();
  const objects = new Set<object>();
  function panel(value: unknown): string {
    const id = identifier(value);
    if (panelIds.has(id)) throw new Error("Duplicate panel identifier");
    panelIds.add(id);
    return id;
  }
  function node(value: unknown, depth = 0): LayoutNode {
    const item = record(value);
    if (depth > 128 || objects.has(item)) throw new Error("Cyclic or excessively deep layout");
    objects.add(item);
    const id = identifier(item.id);
    if (nodeIds.has(id)) throw new Error("Duplicate node identifier");
    nodeIds.add(id);
    if (item.kind === "split") {
      if (item.axis !== "horizontal" && item.axis !== "vertical") throw new Error("Invalid split axis");
      return { kind: "split", id, axis: item.axis, ratio: ratio(item.ratio), first: node(item.first, depth + 1), second: node(item.second, depth + 1) };
    }
    if (item.kind !== "tabs" || !Array.isArray(item.panels)) throw new Error("Expected a tab group");
    const panels = Array.from(item.panels, panel);
    const [first, ...rest] = panels;
    const active = identifier(item.active);
    if (first === undefined || !panels.includes(active)) throw new Error("Invalid active tab");
    return { kind: "tabs", id, panels: [first, ...rest], active };
  }
  const stage = layout.stage === null ? null : node(layout.stage);
  if (!Array.isArray(layout.floating)) throw new Error("Expected floating panels");
  const floating = Array.from(layout.floating, value => {
    const item = record(value);
    return { panel: panel(item.panel), ...bounds(item) };
  });
  if (!Array.isArray(layout.hidden)) throw new Error("Expected hidden panels");
  return { version: 1, stage, floating, hidden: Array.from(layout.hidden, panel) };
}

function findNode(node: LayoutNode | null, id: string): LayoutNode | undefined {
  if (!node) return undefined;
  if (node.id === id) return node;
  return node.kind === "split" ? findNode(node.first, id) ?? findNode(node.second, id) : undefined;
}

function hasPanel(layout: Layout, panel: string): boolean {
  function contains(node: LayoutNode | null): boolean {
    return node !== null && (node.kind === "tabs" ? node.panels.includes(panel) : contains(node.first) || contains(node.second));
  }
  return contains(layout.stage) || layout.hidden.includes(panel) || layout.floating.some(item => item.panel === panel);
}

function mapNode(node: LayoutNode, id: string, change: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return change(node);
  if (node.kind === "tabs") return node;
  const first = mapNode(node.first, id, change);
  const second = mapNode(node.second, id, change);
  return { ...node, first, second };
}

function checkDestination(layout: Layout, destination: Destination): void {
  if (destination.kind === "stage") {
    if (layout.stage) throw new Error("Stage is occupied");
    identifier(destination.group);
  } else if (destination.kind === "tabs") {
    if (findNode(layout.stage, destination.group)?.kind !== "tabs") throw new Error("Unknown tab group");
  } else if (destination.kind === "split") {
    if (!findNode(layout.stage, destination.target)) throw new Error("Unknown split target");
    if (destination.side !== "before" && destination.side !== "after") throw new Error("Invalid split side");
    if (findNode(layout.stage, destination.id) || findNode(layout.stage, destination.group) || destination.id === destination.group) throw new Error("Duplicate node identifier");
  } else if (destination.kind === "floating") {
    bounds(destination);
  } else if (destination.kind !== "hidden") {
    const exhaustive: never = destination;
    throw new Error(`Unknown placement ${String(exhaustive)}`);
  }
}

function place(layout: Layout, panel: string, destination: Destination): Layout {
  checkDestination(layout, destination);
  switch (destination.kind) {
    case "stage": return validateLayout({ ...layout, stage: { kind: "tabs", id: destination.group, panels: [panel], active: panel } });
    case "hidden": return validateLayout({ ...layout, hidden: [...layout.hidden, panel] });
    case "floating": return validateLayout({ ...layout, floating: [...layout.floating, { panel, ...bounds(destination) }] });
    case "tabs": return validateLayout({ ...layout, stage: layout.stage && mapNode(layout.stage, destination.group, node => {
      if (node.kind !== "tabs") throw new Error("Unknown tab group");
      const panels: [string, ...string[]] = [...node.panels];
      const index = destination.index ?? panels.length;
      if (!Number.isInteger(index) || index < 0 || index > panels.length) throw new Error("Invalid tab index");
      panels.splice(index, 0, panel);
      return { ...node, panels, active: panel };
    }) });
    case "split": return validateLayout({ ...layout, stage: layout.stage && mapNode(layout.stage, destination.target, node => {
      const group: LayoutNode = { kind: "tabs", id: destination.group, panels: [panel], active: panel };
      return { kind: "split", id: destination.id, axis: destination.axis, ratio: destination.ratio,
        first: destination.side === "before" ? group : node, second: destination.side === "before" ? node : group };
    }) });
  }
}

export function insertPanel(layout: Layout, panel: string, destination: Destination): Layout {
  const current = validateLayout(layout);
  identifier(panel);
  if (hasPanel(current, panel)) throw new Error("Panel already exists");
  return place(current, panel, destination);
}

export function removePanel(layout: Layout, panel: string): Layout {
  const current = validateLayout(layout);
  if (!hasPanel(current, panel)) throw new Error("Unknown panel");
  function remove(node: LayoutNode | null): LayoutNode | null {
    if (!node) return null;
    if (node.kind === "split") {
      const first = remove(node.first), second = remove(node.second);
      return first && second ? { ...node, first, second } : first ?? second;
    }
    const index = node.panels.indexOf(panel);
    if (index < 0) return node;
    const panels = node.panels.filter(id => id !== panel);
    const [first, ...rest] = panels;
    if (first === undefined) return null;
    return { ...node, panels: [first, ...rest], active: node.active === panel ? panels[index] ?? panels[index - 1] ?? first : node.active };
  }
  return validateLayout({ ...current, stage: remove(current.stage), floating: current.floating.filter(item => item.panel !== panel), hidden: current.hidden.filter(id => id !== panel) });
}

export function movePanel(layout: Layout, panel: string, destination: Destination): Layout {
  const current = validateLayout(layout);
  if (!hasPanel(current, panel)) throw new Error("Unknown panel");
  checkDestination(current, destination);
  if (destination.kind === "tabs") {
    const group = findNode(current.stage, destination.group);
    if (group?.kind === "tabs" && group.panels.length === 1 && group.panels[0] === panel) {
      if (destination.index !== undefined && destination.index !== 0) throw new Error("Invalid tab index");
      return current;
    }
  }
  return place(removePanel(current, panel), panel, destination);
}

export function resizeSplit(layout: Layout, id: string, size: number): Layout {
  const current = validateLayout(layout);
  if (findNode(current.stage, id)?.kind !== "split") throw new Error("Unknown split");
  const nextRatio = ratio(size);
  return validateLayout({ ...current, stage: current.stage && mapNode(current.stage, id, node => {
    if (node.kind !== "split") throw new Error("Unknown split");
    return { ...node, ratio: nextRatio };
  }) });
}

export function resizeFloating(layout: Layout, panel: string, size: Bounds): Layout {
  const current = validateLayout(layout);
  if (!current.floating.some(item => item.panel === panel)) throw new Error("Unknown floating panel");
  const nextBounds = bounds(size);
  return validateLayout({ ...current, floating: current.floating.map(item => item.panel === panel ? { panel, ...nextBounds } : item) });
}

// Version 0 is the pre-release format without hidden panels, defined with v1.
// No previously deployed workspace format is assumed.
export function migrateLayout(value: unknown): Layout {
  const layout = record(value);
  if (layout.version === 0) {
    if ("hidden" in layout) throw new Error("Version 0 cannot contain hidden panels");
    return validateLayout({ ...layout, version: 1, hidden: [] });
  }
  return validateLayout(layout);
}
