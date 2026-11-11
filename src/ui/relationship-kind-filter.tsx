export { mountIntroductionRequest } from "./introduction-request";

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type RelationshipKind = "" | "vendor" | "client" | "lead" | "deal" | "contact";
const options: { value: RelationshipKind; label: string }[] = [
  { value: "", label: "All relationship kinds" },
  { value: "vendor", label: "Vendors" },
  { value: "client", label: "Clients" },
  { value: "lead", label: "Leads" },
  { value: "deal", label: "Deals" },
  { value: "contact", label: "Contacts" },
];
export function relationshipKind(value: unknown): RelationshipKind {
  return options.find((option) => option.value === value)?.value ?? "";
}
export function mountRelationshipKindFilter(
  host: HTMLElement,
  {
    value,
    onChange,
  }: {
    value: RelationshipKind;
    onChange: (kind: RelationshipKind) => void;
  },
) {
  const root = createRoot(host);
  let disposed = false;
  function render(kind: RelationshipKind) {
    if (disposed) return;
    flushSync(() =>
      root.render(
        <>
          <label htmlFor="networkKind">Relationship kind</label>
          <select
            id="networkKind"
            value={kind}
            onChange={(event) => {
              const next = relationshipKind(event.currentTarget.value);
              render(next);
              onChange(next);
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </>,
      ),
    );
  }
  render(value);
  return {
    setValue: render,
    dispose() {
      if (disposed) return;
      disposed = true;
      flushSync(() => root.unmount());
    },
  };
}
