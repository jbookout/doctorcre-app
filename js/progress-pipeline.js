import { taskPulse, taskIdentity, taskSummary } from "./progress-board-model.js";

export function mountProgressPipeline({ flow, taskCount, focusFallback, onTask }) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const phoneQuery = matchMedia("(max-width: 680px)");
  let currentView = null;
  const taskNodes = new Map();
  let renderedStages = "";

  function svg(tag, className, attributes = {}, content) {
    const node = document.createElementNS(SVG_NS, tag);
    if (className) node.setAttribute("class", className);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (content !== undefined) node.textContent = String(content);
    return node;
  }

  function titleLines(value, width) {
    const words = String(value).split(/\s+/).filter(Boolean);
    const lines = [];
    for (const word of words) {
      const last = lines.length - 1;
      if (last >= 0 && `${lines[last]} ${word}`.length <= width) lines[last] += ` ${word}`;
      else lines.push(word);
    }
    if (lines.length > 2) return [lines[0], `${lines[1].slice(0, width - 1)}…`];
    return lines;
  }

  function taskNode(task, stage, x, y, width, height, phone) {
    const pulse = taskPulse(task);
    const identity = taskIdentity(task);
    const node = svg("g", "pipeline-node", { "data-task-id": task.id, "data-stage": stage.id,
      "data-pulse": pulse, role: "button", tabindex: 0,
      "aria-label": `${task.title || task.id}, ${stage.label}. Open task detail.` });
    node.append(svg("rect", "node-shape", { x, y, width, height, rx: 12 }));
    node.append(svg("circle", "node-halo", { cx: x + 20, cy: y + 23, r: 8 }));
    node.append(svg("circle", "node-pulse", { cx: x + 20, cy: y + 23, r: 12 }));
    const title = String(task.title || task.id);
    const lines = titleLines(title, phone ? 38 : 18);
    const label = svg("text", "node-label", { x: x + 35, y: y + 26 });
    for (const [index, line] of lines.entries()) {
      label.append(svg("tspan", "", { x: x + 35, dy: index ? 14 : 0 }, line));
    }
    node.append(label);
    const summary = taskSummary(task);
    const summaryLimit = phone ? 46 : 24;
    node.append(svg("text", "node-summary", { x: x + 12, y: y + height - 42 },
      summary.length > summaryLimit ? `${summary.slice(0, summaryLimit - 1)}…` : summary));
    node.append(svg("text", "node-meta", { x: x + 12, y: y + height - 27 }, identity.provider));
    node.append(svg("text", "node-meta", { x: x + 12, y: y + height - 13 },
      `${identity.model} · ${identity.effort}`));
    const retained = taskNodes.get(task.id);
    const target = retained?.node || node;
    if (retained) {
      target.replaceChildren(...node.childNodes);
      for (const attribute of node.attributes) target.setAttribute(attribute.name, attribute.value);
    }
    const entry = { node: target, task, stage };
    taskNodes.set(task.id, entry);
    if (retained) return target;
    const open = () => {
      const current = taskNodes.get(task.id);
      if (current) onTask(current.task);
    };
    node.addEventListener("click", open);
    node.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });
    return node;
  }

  function render(view) {
    currentView = view;
    const phone = phoneQuery.matches;
    const signature = JSON.stringify([view.stages, phone]);
    if (signature === renderedStages) {
      for (const { node, task } of taskNodes.values()) node.setAttribute("data-pulse", taskPulse(task));
      return;
    }
    renderedStages = signature;
    const focusedId = [...taskNodes].find(([, entry]) => entry.node === document.activeElement)?.[0];
    flow.replaceChildren();
    const total = view.stages.reduce((sum, stage) => sum + stage.tasks.length, 0);
    taskCount.textContent = `${total} TASK${total === 1 ? "" : "S"}`;
    const width = phone ? 360 : Math.max(1200, view.stages.length * 199 + 8);
    const maxTasks = Math.max(1, ...view.stages.map(stage => stage.tasks.length));
    const height = phone ? view.stages.reduce((sum, stage) => sum + Math.max(106, 69 + stage.tasks.length * 115) + 21, 0) - 21
      : Math.max(270, 93 + maxTasks * 115);
    flow.setAttribute("viewBox", `0 0 ${width} ${height}`);
    flow.setAttribute("aria-label", `${total} tasks positioned across ${view.stages.map(stage => stage.label).join(", ")}`);
    let offset = 0;
    view.stages.forEach((stage, index) => {
      const x = phone ? 8 : 8 + index * 199;
      const y = phone ? offset : 8;
      const wellWidth = phone ? 344 : 186;
      const wellHeight = phone ? Math.max(106, 69 + stage.tasks.length * 115) : height - 16;
      const group = svg("g", "flow-stage", { "data-stage": stage.id, color: stage.color });
      group.append(svg("rect", "stage-well", { x, y, width: wellWidth, height: wellHeight, rx: 15 }));
      if (stage.sequence !== false) group.append(svg("text", "stage-index", { x: x + 15, y: y + 27 }, String(index + 1).padStart(2, "0")));
      group.append(svg("text", "stage-label", { x: x + (stage.sequence === false ? 15 : 47), y: y + 28 }, stage.label));
      group.append(svg("text", "stage-count", { x: x + wellWidth - 14, y: y + 27, "text-anchor": "end" },
        String(stage.tasks.length).padStart(2, "0")));
      if (!stage.tasks.length) group.append(svg("text", "flow-empty", { x: x + 15, y: y + 79 }, "No tasks"));
      stage.tasks.forEach((task, taskIndex) => group.append(taskNode(task, stage, x + 9,
        y + 44 + taskIndex * 115, wellWidth - 18, 106, phone)));
      flow.append(group);
      if (index < view.stages.length - 1 && stage.sequence !== false && view.stages[index + 1].sequence !== false) {
        const d = phone ? `M 180 ${y + wellHeight + 2} V ${y + wellHeight + 19}`
          : `M ${x + wellWidth + 2} 47 H ${x + 197}`;
        flow.append(svg("path", "pipeline-connector", { d, "aria-hidden": "true" }));
      }
      if (phone) offset += wellHeight + 21;
    });
    const ids = new Set(view.stages.flatMap(stage => stage.tasks.map(task => task.id)));
    for (const id of taskNodes.keys()) if (!ids.has(id)) taskNodes.delete(id);
    if (focusedId) (taskNodes.get(focusedId)?.node || focusFallback).focus();
  }

  phoneQuery.addEventListener("change", () => { if (currentView) render(currentView); });


  return { render, clear() { currentView = null; renderedStages = ""; taskNodes.clear(); flow.replaceChildren(); taskCount.textContent = "—"; } };
}
