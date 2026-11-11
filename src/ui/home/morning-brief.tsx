import { useEffect, useRef } from "react";

export function MorningBrief() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.dispatchEvent(new Event("doctorcre:mount-home-brief"));
    const node = host.current;
    if (location.hash === "#homeBrief") node?.scrollIntoView({ block: "start" });
    return () => {
      const brief = node?.querySelector<HTMLElement>("#docMorningBrief");
      if (brief) {
        brief.hidden = true;
        document.body.append(brief);
      }
    };
  }, []);
  return <div id="homeBrief" data-inline-morning-brief ref={host} className="home-morning-brief" />;
}
