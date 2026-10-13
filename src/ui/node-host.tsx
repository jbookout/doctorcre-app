import { useLayoutEffect, useRef } from "react";

// Hosts an existing page node inside a React-managed container. The node is
// moved, never cloned or re-rendered: its identity, listeners, drafts and ids
// survive, and React never reconciles anything inside it. Unmounting puts the
// node back where it was found.
export function NodeHost({ node }: { node: Element }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = container.current;
    if (!host) return;
    const home = node.ownerDocument.createComment("node-host");
    node.replaceWith(home);
    host.append(node);
    return () => home.replaceWith(node);
  }, [node]);
  return <div ref={container} className="node-host" data-node-host="" />;
}
