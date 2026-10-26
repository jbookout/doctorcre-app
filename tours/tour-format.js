
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

const UUID_IN_TEXT = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi;
/** A tour's name for lists and headings: record IDs inside a generated name
 *  are dropped so it reads as words; the full name stays in the title. */
export function tourDisplayName(name, fallback = "Untitled tour") {
  const words = typeof name === "string" ? name.replace(UUID_IN_TEXT, " ").replace(/\s+/g, " ").trim() : "";
  return words || fallback;
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

export function itinerarySheetText(tour) {
  const route = tour?.routes?.find(row => row.accepted === true);
  const stops = route?.stops?.filter(stop => stop.stop_state === "active");
  if (!Number.isSafeInteger(route?.route_version) || !stops?.length) return "";
  const omitted = route.stops.filter(stop => stop.stop_state === "held" || stop.stop_state === "excluded");
  const recorded = value => typeof value === "string" && value.trim() ? value : "Not recorded";
  const minutes = value => Number.isInteger(value) && value >= 0 ? `${value} minutes` : "Not recorded";
  const timing = stop => [
    `Appointment start: ${recorded(stop.appointment_start)}`,
    `Appointment end: ${recorded(stop.appointment_end)}`,
    `Dwell: ${minutes(stop.dwell_minutes)}`,
    `Buffer: ${minutes(stop.buffer_minutes)}`,
  ].join("\n");
  return ["Internal only. Not for client distribution.", tourDisplayName(tour.name), `Accepted route version ${route.route_version}`,
    ...[...stops].sort((a, b) => a.route_sequence - b.route_sequence).map(stop => [
      `${stop.route_label} · ${recorded(stop.property_name || stop.name)}`,
      `Address: ${recorded(stop.property_address || stop.address)}`,
      timing(stop),
    ].join("\n")),
    ...(omitted.length ? ["Not on the active itinerary", ...omitted.map(stop => [
      recorded(stop.property_name || stop.name),
      `Status: ${stop.stop_state === "held" ? "Held" : "Excluded"}`,
      `Address: ${recorded(stop.property_address || stop.address)}`,
      timing(stop),
    ].join("\n"))] : []),
  ].join("\n\n");
}

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
