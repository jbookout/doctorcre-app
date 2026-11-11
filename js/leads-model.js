export const BOARD_STAGES = Object.freeze([
  ["new", "New"], ["qualified", "Qualified"], ["outreach_active", "Outreach Active"],
  ["engaged", "Engaged"], ["nurture_drip", "Nurture"], ["opportunity", "Opportunity"],
]);
export const FILTER_STAGES = [...BOARD_STAGES, ["archived", "Archived"]];
export const stageLabel = stage => FILTER_STAGES.find(([key]) => key === stage)?.[1] || ({ do_not_contact: "Do Not Contact", closed_lost: "Nurture", closed_won: "Converted to deal", active_deal: "Deal" }[stage]) || "Unassigned";
export const normalizedStage = lead => lead.do_not_contact ? "do_not_contact" :
  ["nurture", "closed_lost"].includes(lead.stage) ? "nurture_drip" : lead.stage;

// Ordered eligibility: suppression/tombstone, then exact lifecycle links,
// then terminal conversion stages. A name match is never an exclusion.
export function eligibleLead(lead) {
  if (lead.suppressed || lead.merged_into || lead.deleted_at) return false;
  if (lead.prospect_client_id && lead.prospect_engagement_status === "inactive") return true;
  if (lead.client_id || lead.linked_client || lead.is_client || lead.is_past_client || lead.is_deal || lead.deal_id) return false;
  return !["active_deal", "closed_won"].includes(lead.stage);
}
function cleanTitle(value) {
  return String(value || "").replace(/\s*\((?:via|referral|referred)[^)]*\)/gi, "").trim();
}
export function leadTitle(lead) {
  const named = [lead.doctor_name, lead.practice_name, lead.entity_name, lead.name].map(cleanTitle).find(Boolean);
  return named || `${lead.specialty || lead.vertical || "Practice"} ${lead.plan_type || "startup"}${lead.city ? ` in ${lead.city}` : ""}`;
}
export const marketKey = lead => lead.market || [lead.city, lead.state].filter(Boolean).join(", ") || "Market pending";
export const specialtyKey = lead => lead.specialty?.trim() || lead.vertical?.trim() || "Specialty pending";
export function visibleLeads(leads, filters = {}) {
  const search = (filters.search || "").trim().toLowerCase();
  return leads.filter(eligibleLead).filter(lead => {
    const stage = normalizedStage(lead);
    return (filters.stage ? stage === filters.stage : BOARD_STAGES.some(([key]) => key === stage)) &&
      (!filters.reachability || (lead.reachability?.classification || "research") === filters.reachability) &&
      (!filters.owner || lead.owner === filters.owner) && (!filters.market || marketKey(lead) === filters.market) &&
      (!filters.specialty || specialtyKey(lead) === filters.specialty) &&
      (!search || [leadTitle(lead), lead.specialty, marketKey(lead), lead.party_id].join(" ").toLowerCase().includes(search));
  });
}
export function marketCounts(leads, filters = {}, locate = () => null) {
  const counts = new Map();
  for (const lead of visibleLeads(leads, filters)) {
    const place = locate(lead), key = marketKey(lead);
    const group = counts.get(key) || { key, count: 0, locations: new Map(), unlocatedIds: [] };
    if (place) {
      const location = group.locations.get(place.id) || { place, leadIds: [] };
      location.leadIds.push(lead.id); group.locations.set(place.id, location);
    } else group.unlocatedIds.push(lead.id);
    group.count++; counts.set(key, group);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map(group => ({ ...group, locations: [...group.locations.values()] }));
}
export function leadTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts || parts[0] !== value) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60
    && (Number.isNaN(offsetHour) || offsetHour < 24 && offsetMinute < 60))) return null;
  return { seconds: Date.parse(value.replace(/\.\d+/, "")) / 1000, fraction: (parts[7] || "").replace(/0+$/, "") };
}
function compareInstants(a, b) {
  return a.seconds - b.seconds || (a.fraction < b.fraction ? -1 : a.fraction > b.fraction ? 1 : 0);
}
export function stageReview(detail, target, now = Date.now()) {
  const kinds = target === "engaged" ? ["email_in", "meeting", "call"] : target === "outreach_active" ? ["email_out"] : [];
  const current = leadTimestamp(new Date(now).toJSON());
  const evidence = (detail.correspondence || []).map(entry => ({ entry, instant: leadTimestamp(entry.occurred_at) }))
    .filter(({ entry, instant }) => kinds.includes(entry.kind) && (entry.kind !== "call" || entry.connected === true) &&
      instant !== null && current !== null && compareInstants(instant, current) <= 0)
    .sort((a, b) => compareInstants(b.instant, a.instant)).slice(0, 3).map(({ entry }) => entry);
  const questions = { new: "Why return this lead to New?", qualified: "What makes this lead qualified?",
    outreach_active: "What outreach has started?", engaged: "What contact has taken place?",
    nurture_drip: "What is the follow-up plan?", opportunity: "What space plans are confirmed?",
    archived: "Why has this lead ended?" };
  return { evidence, question: evidence.length ? null : questions[target],
    reason: evidence.length ? ({ email_in: "Reply received", meeting: "Meeting held", call: "Call completed", email_out: "Outreach sent" }[evidence[0].kind]) : null };
}
export function automaticMove(lead) {
  const move = lead.last_stage_move;
  if (!move?.automatic || move.undone || move.to !== lead.stage || !move.from || !move.event_id) return null;
  return move;
}
export function undoReview(lead, humanQuote = "") {
  const move = automaticMove(lead);
  if (!move || !(move.from === "closed_lost" || FILTER_STAGES.some(([key]) => key === move.from))) return null;
  return { stage: move.from, question: "Why undo this automatic stage move?",
    stage_review: { reason: "Undo automatic stage move", evidence_ids: [], undo_event_id: move.event_id, human_quote: humanQuote } };
}
