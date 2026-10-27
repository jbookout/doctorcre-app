import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { mountWorkspace } from "./workspace-shell";
import type { Layout, LayoutNode } from "./workspace-layout";

type Group = Extract<LayoutNode, { kind: "tabs" }>;

export function mountZoomableWorkspace(options: Parameters<typeof mountWorkspace>[0]): ReturnType<typeof mountWorkspace> {
  const { container, panels } = options;
  const document = container.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error("Zoom workspace requires a browser document");
  const ElementType = view.Element;
  if (!container.isConnected || container.childNodes.length) throw new Error("Zoom workspace requires an empty mounted container");
  const controls = document.createElement("div");
  const stage = document.createElement("div");
  stage.className = "workspace-zoom-stage";
  container.append(controls, stage);
  let shell;
  try { shell = mountWorkspace({ ...options, container: stage }); }
  catch (error) { controls.remove(); stage.remove(); throw error; }
  const root = createRoot(controls);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/css/workspace-zoom.css";
  document.head.append(stylesheet);
  container.classList.add("workspace-zoom");
  let selected: string | null = null;
  let groups: Group[] = [];
  let disposed = false;
  const titles = new Map(panels.map(panel => [panel.id, panel.title]));

  function render() {
    const elements = stage.querySelectorAll<HTMLElement>(".workspace-group");
    stage.classList.toggle("workspace-is-zoomed", selected !== null);
    elements.forEach((element, index) => {
      const zoomed = groups[index]?.id === selected;
      const obscured = selected !== null && !zoomed;
      element.classList.toggle("workspace-zoomed-group", zoomed);
      element.inert = obscured;
      if (obscured) element.setAttribute("aria-hidden", "true");
      else element.removeAttribute("aria-hidden");
    });
    flushSync(() => root.render(<div className="workspace-zoom-controls" role="group" aria-label="Zoom workspace groups">
      {groups.map(group => <button key={group.id} type="button" className="btn btn-quiet"
        hidden={selected !== null && selected !== group.id}
        aria-pressed={selected === group.id}
        onClick={() => { selected = selected === group.id ? null : group.id; render(); }}>
        {selected === group.id ? "Return to workspace" : `Zoom ${group.panels.map(id => titles.get(id)).join(", ")} group`}
      </button>)}
    </div>));
  }
  function refresh(layout: Layout) {
    groups = [];
    function visit(node: LayoutNode) {
      if (node.kind === "tabs") groups.push(node);
      else { visit(node.first); visit(node.second); }
    }
    if (layout.stage) visit(layout.stage);
    if (!groups.some(group => group.id === selected)) selected = null;
    render();
  }
  function doubleClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof ElementType)) return;
    const tabs = target.closest(".workspace-tabs");
    if (!tabs || !stage.contains(tabs)) return;
    const element = tabs.closest(".workspace-group");
    if (!element) return;
    const index = [...stage.querySelectorAll(".workspace-group")].indexOf(element);
    const group = groups[index];
    if (group) { selected = selected === group.id ? null : group.id; render(); }
  }
  function keyDown(event: KeyboardEvent) {
    const target = event.target;
    if (event.key !== "Escape" || event.defaultPrevented || selected === null) return;
    if (target instanceof ElementType && target.closest('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
    selected = null;
    render();
    event.preventDefault();
  }
  container.addEventListener("dblclick", doubleClick);
  container.addEventListener("keydown", keyDown);
  refresh(options.layout);
  return {
    update(layout) {
      if (disposed) throw new Error("Workspace is unmounted");
      shell.update(layout);
      refresh(layout);
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      container.removeEventListener("dblclick", doubleClick);
      container.removeEventListener("keydown", keyDown);
      root.unmount();
      shell.unmount();
      controls.remove(); stage.remove(); stylesheet.remove();
      container.classList.remove("workspace-zoom");
    },
  };
}
