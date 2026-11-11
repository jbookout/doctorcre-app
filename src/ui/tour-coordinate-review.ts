import type { ReceiptInput, ReviewBinding, ReviewResult } from "./tour-coordinate-review-model.ts";
import { coordinateReviewSession, parseCoordinateReview } from "./tour-coordinate-review-model.ts";

type Stop = { property_id: string; coordinate_review?: unknown };

export { entranceReceiptResult } from "./tour-coordinate-review-model.ts";
export function mountCoordinateReview(
  root: HTMLElement,
  options: {
    binding: Omit<ReviewBinding, "property">;
    stops: Stop[];
    read: (propertyId: string) => Promise<unknown>;
    write: (args: ReceiptInput) => Promise<ReviewResult>;
  },
) {
  const doc = root.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  };
  const snapshots = new Map(
    options.stops.map((stop) => [stop.property_id, parseCoordinateReview(stop.coordinate_review, stop.property_id)]),
  );
  let selected = options.stops[0]?.property_id ?? "";
  let session: ReturnType<typeof coordinateReviewSession> | null = null;
  let retired = false;
  const button = (text: string, action: () => void, disabled = false) => {
    const node = el("button", text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  };
  function render() {
    root.replaceChildren();
    root.classList.add("coordinate-review");
    root.append(
      el("h2", "Review stop coordinates"),
      el(
        "p",
        "Compare recorded candidates before a showing. Entrance approval is separate from route and map promotion.",
      ),
    );
    if (retired) {
      root.append(el("p", "Session ended. Reopen the Tour after signing in."));
      return;
    }
    const label = el("label", "Property");
    const picker = el("select");
    picker.dataset.coordinateProperty = "";
    for (const stop of options.stops) {
      const evidence = snapshots.get(stop.property_id);
      const option = el("option", evidence?.property_name ?? "Property name unknown");
      option.value = stop.property_id;
      picker.append(option);
    }
    picker.value = selected;
    picker.disabled = ["reviewing", "unknown"].includes(session?.phase ?? "");
    picker.addEventListener("change", () => select(picker.value));
    label.append(picker);
    root.append(label);
    const phase = session?.phase;
    const messages = {
      reading: "Reading current coordinate evidence…",
      unavailable: "Coordinate evidence is unavailable. Refresh to retry.",
      reviewing: "Submitting human evidence…",
      refused:
        "Entrance review refused. A verified human partner and reviewed entrance evidence are required. No approval was recorded.",
      unknown: "Review outcome is unknown. Retry uses the exact same request and key.",
      comparing: "Recorded evidence. Comparison changes no facts.",
      retired: "Session ended.",
    };
    const status = el("p", phase ? messages[phase] : "No stop selected.");
    status.setAttribute("role", "status");
    root.append(status);
    const refresh = button(
      "Refresh coordinate evidence",
      () => void session?.refresh(),
      !session || ["reading", "reviewing", "unknown"].includes(phase ?? ""),
    );
    root.append(refresh);
    if (phase === "unknown") root.append(button("Retry exact review request", () => void session?.resubmit()));
    const review = session?.review;
    if (!review) {
      root.append(el("p", "Coordinate evidence unknown. No review pin is available."));
      return;
    }
    root.append(
      el("h3", review.property_name ?? "Property name unknown"),
      el("p", review.property_address ?? "Address unknown"),
      el("small", `Evidence as of ${review.as_of}`),
    );
    if (review.status === "unknown")
      root.append(el("p", "No observed coordinate candidates. Pin and entrance approval unknown."));
    const grid = el("div");
    grid.className = "coordinate-candidates";
    for (const candidate of review.candidates) {
      const card = el("article");
      card.dataset.coordinateCandidate = candidate.coordinate_candidate_id;
      card.append(
        el("h4", candidate.coordinate_role.replaceAll("_", " ")),
        el(
          "p",
          candidate.approval.status === "verified_entrance"
            ? "Human entrance approved. Route promotion is checked separately."
            : `Entrance not approved · ${candidate.approval.status.replaceAll("_", " ")}`,
        ),
      );
      const fields = el("dl");
      const rows = (value: unknown, prefix = "") => {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          for (const [key, item] of Object.entries(value)) rows(item, prefix ? `${prefix}.${key}` : key);
          return;
        }
        const dt = el("dt", prefix.replaceAll("_", " "));
        const dd = el("dd", value === null ? "Unknown" : Array.isArray(value) ? value.join(", ") : String(value));
        dd.dataset.coordinateField = prefix;
        fields.append(dt, dd);
      };
      const summary = el(
        "p",
        candidate.position
          ? `${candidate.position.latitude}, ${candidate.position.longitude} · ${candidate.precision_class}`
          : "Coordinates withheld · " + candidate.precision_class,
      );
      card.append(
        summary,
        el("p", `Source · ${candidate.source.provider ?? "Unknown"} | Rights · ${candidate.rights.status}`),
      );
      rows(candidate);
      const provenance = el("details");
      provenance.append(el("summary", "Candidate, source and receipt details"), fields);
      card.append(provenance);
      if (candidate.rights.status !== "usable")
        card.append(
          el("p", "Coordinates withheld because source rights are unavailable. No pin or navigation is supplied."),
        );
      if (
        candidate.rights.status === "usable" &&
        candidate.review_state === "reviewed" &&
        ["entrance", "driveway", "parking_access"].includes(candidate.coordinate_role) &&
        candidate.approval.status !== "verified_entrance"
      ) {
        const details = el("details");
        details.append(el("summary", "Record human entrance verification"));
        details.append(
          el(
            "p",
            "Only a verified human partner can record this receipt. Supply the actual site evidence and completed native navigation test. Authority and verifier come from the server.",
          ),
        );
        const form = el("form");
        const inputs = new Map<string, HTMLInputElement>();
        for (const [key, title, type] of [
          ["verified_at", "Verified at", "datetime-local"],
          ["evidence_reference", "Site evidence reference", "text"],
          ["receipt_digest", "Receipt digest (sha256)", "text"],
          ["tested_at", "Native navigation tested at", "datetime-local"],
          ["evidence_digest", "Navigation evidence digest (sha256)", "text"],
        ]) {
          if (!key || !title || !type) continue;
          const field = el("label", title),
            input = el("input");
          input.type = type;
          input.required = true;
          input.name = key;
          inputs.set(key, input);
          if (key.endsWith("digest")) input.pattern = "sha256:[a-f0-9]{64}";
          field.append(input);
          form.append(field);
        }
        const choices = (name: string, values: string[]) => {
          const field = el("label", name.replaceAll("_", " ")),
            control = el("select");
          control.name = name;
          for (const value of values) {
            const option = el("option", value);
            option.value = value;
            control.append(option);
          }
          field.append(control);
          form.append(field);
          return control;
        };
        const platform = choices("platform", ["google_maps", "apple_maps"]),
          mode = choices("travel_mode", ["driving", "walking"]);
        const confirm = el("label", "I personally verified this entrance and completed the navigation test");
        const checked = el("input");
        checked.type = "checkbox";
        checked.required = true;
        confirm.prepend(checked);
        form.append(confirm);
        const submit = el("button", "Submit human verification");
        submit.type = "submit";
        submit.disabled = phase !== "comparing" && phase !== "refused";
        form.append(submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!form.reportValidity()) return;
          const value = (key: string) => inputs.get(key)?.value ?? "";
          void session?.submit({
            idempotency_key: crypto.randomUUID(),
            property_id: selected,
            coordinate_candidate_id: candidate.coordinate_candidate_id,
            verified_at: new Date(value("verified_at")).toISOString(),
            evidence_reference: value("evidence_reference"),
            receipt_digest: value("receipt_digest"),
            native_navigation_proof: {
              platform: platform.value,
              tested_at: new Date(value("tested_at")).toISOString(),
              travel_mode: mode.value,
              evidence_digest: value("evidence_digest"),
            },
          });
        });
        details.append(form);
        card.append(details);
      }
      grid.append(card);
    }
    root.append(grid);
  }
  function select(property: string) {
    session?.retire();
    selected = property;
    session = coordinateReviewSession({ ...options.binding, property }, snapshots.get(property), {
      read: () => options.read(property),
      write: options.write,
      changed: () => {
        if (session?.review) snapshots.set(property, session.review);
        render();
      },
    });
    render();
  }
  select(selected);
  return {
    retire() {
      retired = true;
      snapshots.clear();
      session?.retire();
      render();
    },
  };
}
