// Human words for the Tours page. Pure functions only, so they can be tested
// without a browser; tours/app.js paints what these return.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "Sep 28, 2026, 2:05 PM" for a timestamp, "Oct 3, 2026" for a calendar date, "" when unreadable. */
export function formatTourDate(value, { timeZone } = {}) {
  if (typeof value !== "string" || !value) return "";
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}),
  });
}

export function tourMetaLine(tour, options) {
  const updated = formatTourDate(tour?.updated_at, options);
  return [tour?.client_name, tour?.market, updated ? `Updated ${updated}` : ""].filter(Boolean).join(" · ");
}

/** The cheat sheet as editable text. Empty content is "", never "{}". */
export function cheatSheetText(content) {
  if (typeof content === "string") return content.trim() === "{}" ? "" : content;
  if (!content || typeof content !== "object") return "";
  const keys = Object.keys(content);
  if (keys.length === 0) return "";
  if (keys.length === 1 && keys[0] === "notes" && typeof content.notes === "string") return content.notes;
  return JSON.stringify(content, null, 2);
}

// Projection keys as a broker would say them. Anything unmapped is humanized.
const FACT_LABELS = Object.freeze({
  "display.name": "Property name",
  "display.address": "Address",
  asking_economics: "Asking rent and terms",
  source_attribution: "Source",
  available_space: "Available space",
  building_size: "Building size",
  property_type: "Property type",
  parking_ratio: "Parking ratio",
  land_area: "Land area",
  map_position: "Map location",
  photo_refs: "Photos",
});

export function factLabel(key) {
  const name = String(key || "");
  if (FACT_LABELS[name]) return FACT_LABELS[name];
  const bare = name.replace(/^(display|facts?|property)\./, "");
  if (FACT_LABELS[bare]) return FACT_LABELS[bare];
  const words = bare.replace(/[._]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Property fact";
}

/** The facts a projection row carries beyond the name and address already shown. */
export function factSummary(facts) {
  const labels = Object.keys(facts && typeof facts === "object" ? facts : {})
    .filter((key) => key !== "display.name" && key !== "display.address")
    .map(factLabel)
    .sort((a, b) => a.localeCompare(b));
  return labels.length ? `Includes: ${[...new Set(labels)].join(", ")}` : "";
}
