import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export function MorningBrief() {
  const [expanded, setExpanded] = useState(
    () => !window.matchMedia("(max-width: 1100px)").matches || location.hash === "#homeBrief",
  );
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const expand = () => flushSync(() => setExpanded(true));
    document.addEventListener("doctorcre:open-home-brief", expand);
    document.dispatchEvent(new Event("doctorcre:mount-home-brief"));
    const node = host.current;
    if (location.hash === "#homeBrief") node?.scrollIntoView({ block: "start" });
    return () => {
      document.removeEventListener("doctorcre:open-home-brief", expand);
      const brief = node?.querySelector<HTMLElement>("#docMorningBrief");
      if (brief) {
        brief.hidden = true;
        document.body.append(brief);
      }
    };
  }, []);
  return (
    <aside className="home-morning-brief" data-expanded={expanded} aria-label="Morning brief">
      <button
        type="button"
        className="home-brief-toggle"
        aria-expanded={expanded}
        aria-controls="homeBrief"
        onClick={() => setExpanded(!expanded)}
      >
        <span>Morning brief</span>
        <span>{expanded ? "Collapse" : "Open brief"}</span>
      </button>
      <div id="homeBrief" data-inline-morning-brief ref={host} />
    </aside>
  );
}
