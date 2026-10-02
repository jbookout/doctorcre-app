// App-only drafts. No property facts, provider rights or business changes are inferred.
export const PLAN_FIELDS = ["name", "date", "time", "area", "use", "start", "end", "dwell", "buffer", "notes"];
export const SEARCH_FIELDS = ["area", "use", "minSize", "maxSize", "budget", "rentBasis", "transaction", "availableBy", "parking", "requirements"];

export function createDraft(fields) {
  let values = Object.fromEntries(fields.map(field => [field, ""]));
  const history = [];
  const managed = new Set();
  return {
    get values() { return { ...values }; },
    get canUndo() { return history.length > 0; },
    set(field, value, suggested = false) {
      if (!fields.includes(field) || typeof value !== "string" || values[field] === value) return false;
      history.push({ field, before: values[field] }); values[field] = value;
      if (suggested) managed.add(field); else managed.delete(field); return true;
    },
    suggest(suggestions) { for (const field of fields) if (suggestions[field] && !values[field]) this.set(field, String(suggestions[field]), true); },
    refreshSuggestions(suggestions) { for (const field of managed) this.set(field, String(suggestions[field] || ""), true); },
    undo() { const change = history.pop(); if (change) { values[change.field] = change.before; managed.delete(change.field); } return change?.field || null; },
    reset(saved = {}) { values = Object.fromEntries(fields.map(field => [field, typeof saved[field] === "string" ? saved[field] : ""])); history.length = 0; managed.clear(); },
  };
}

export function clientSuggestions(record) {
  return {
    name: record.name ? `${record.name} · Tour` : "",
    area: [record.city, record.state].filter(Boolean).join(", "),
    use: record.vertical || record.specialty || "",
    notes: typeof record.notes === "string" ? record.notes.length > 180 ? `${record.notes.slice(0, 177)}…` : record.notes : "",
  };
}

export function tourGroups(tours, query = "") {
  const term = query.trim().toLocaleLowerCase();
  const matching = tours.filter(tour => `${tour.name || ""} ${tour.status || ""}`.toLocaleLowerCase().includes(term));
  return {
    upcoming: matching.filter(tour => !["completed", "finished", "cancelled", "canceled", "archived"].includes(tour.status)),
    history: matching.filter(tour => ["completed", "finished", "cancelled", "canceled", "archived"].includes(tour.status)),
  };
}

export function validateCriteria(values) {
  if (!values.area.trim()) return "Choose an area.";
  for (const field of ["minSize", "maxSize", "budget"]) if (values[field] && (!Number.isFinite(Number(values[field])) || Number(values[field]) < 0)) return "Enter a positive size and budget.";
  if (values.minSize && values.maxSize && Number(values.minSize) > Number(values.maxSize)) return "Maximum size must exceed minimum size.";
  return "";
}

export function addPrivateFiles(current, incoming) {
  const next = [...current];
  for (const file of incoming) {
    if (!file || file.size > 25 * 1024 * 1024) throw new Error("Files must be 25 MB or smaller.");
    if (next.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
    if (next.length >= 12) throw new Error("Keep up to 12 files in a packet draft.");
    next.push(file);
  }
  return next;
}
