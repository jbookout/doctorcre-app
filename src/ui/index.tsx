import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { NodeHost } from "./node-host";

export { mountWorkspace } from "./workspace-shell";
export { mountZoomableWorkspace } from "./workspace-zoom";

// Puts a React-managed container where `node` stands and moves the node into
// it before returning. The returned root's unmount() restores the page.
export function hostNode(node: Element): Root {
  const container = node.ownerDocument.createElement("div");
  node.before(container);
  const root = createRoot(container);
  flushSync(() => root.render(<NodeHost node={node} />));
  return root;
}
