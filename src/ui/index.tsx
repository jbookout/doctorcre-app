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
import { bootInbox } from './home/boot';
// inbox.html loads this bundle directly; every other page imports it on demand.
const inboxRoot = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#homeRoot[data-inbox]');
if (inboxRoot) void bootInbox(inboxRoot);

export { mountFactReview } from "./fact-review";

export { mountMarketTerms } from "./market-terms";

export { homeListLimit } from './home-list-limit';
export { createContactReasonsView } from './contact-reasons';

export { mountActionLink } from './action-link';
