export const BOARD_STAGES = Object.freeze([
  ["new", "New"], ["qualified", "Qualified"], ["outreach_active", "Outreach Active"],
  ["engaged", "Engaged"], ["nurture_drip", "Nurture"], ["opportunity", "Opportunity"],
]);
export const FILTER_STAGES = [...BOARD_STAGES, ["do_not_contact", "Do Not Contact"], ["archived", "Archived"]];
export const stageLabel = stage => FILTER_STAGES.find(([key]) => key === stage)?.[1] || ({ closed_lost: "Nurture", closed_won: "Converted to deal", active_deal: "Deal" }[stage]) || "Unassigned";
export const normalizedStage = lead => lead.do_not_contact ? "do_not_contact" :
  ["nurture", "closed_lost"].includes(lead.stage) ? "nurture_drip" : lead.stage;

// Ordered eligibility: suppression/tombstone, then exact lifecycle links,
// then terminal conversion stages. A name match is never an exclusion.
export function eligibleLead(lead) {
  if (lead.suppressed || lead.merged_into || lead.deleted_at) return false;
  if (lead.client_id || lead.linked_client || lead.is_client || lead.is_past_client || lead.is_deal || lead.deal_id) return false;
  return !["active_deal", "closed_won"].includes(lead.stage);
}
export function cleanTitle(value) {
  return String(value || "").replace(/\s*\((?:via|referral|referred)[^)]*\)/gi, "").trim();
}
export function leadTitle(lead) {
  const named = [lead.doctor_name, lead.practice_name, lead.entity_name, lead.name].map(cleanTitle).find(Boolean);
  return named || `${lead.specialty || lead.vertical || "Practice"} ${lead.plan_type || "startup"}${lead.city ? ` in ${lead.city}` : ""}`;
}
export const marketKey = lead => lead.market || [lead.city, lead.state].filter(Boolean).join(", ") || "Market pending";
export function visibleLeads(leads, filters = {}) {
  const search = (filters.search || "").trim().toLowerCase();
  return leads.filter(eligibleLead).filter(lead => {
    const stage = normalizedStage(lead);
    return (filters.stage ? stage === filters.stage : BOARD_STAGES.some(([key]) => key === stage)) &&
      (!filters.owner || lead.owner === filters.owner) && (!filters.market || marketKey(lead) === filters.market) &&
      (!search || [leadTitle(lead), lead.specialty, marketKey(lead), lead.party_id].join(" ").toLowerCase().includes(search));
  });
}
export function hottestLeads(leads) {
  return leads.filter(eligibleLead).filter(lead => normalizedStage(lead) === "new" && !lead.owner)
    .sort((a, b) => scoreValue(b) - scoreValue(a) || leadTitle(a).localeCompare(leadTitle(b))).slice(0, 5);
}
const scoreValue = lead => lead.score == null || !Number.isFinite(Number(lead.score)) ? -Infinity : Number(lead.score);
export function marketCounts(leads, filters = {}) {
  const counts = new Map();
  for (const lead of visibleLeads(leads, { ...filters, market: "", stage: filters.stage === "archived" ? "" : filters.stage })) {
    if (normalizedStage(lead) === "archived") continue;
    const key = marketKey(lead); const group = counts.get(key) || { key, count: 0, city: lead.city, state: lead.state };
    group.count++; counts.set(key, group);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
export function stageReview(detail, target, now = Date.now()) {
  const kinds = target === "engaged" ? ["email_in", "meeting", "call"] : target === "outreach_active" ? ["email_out"] : [];
  const evidence = (detail.correspondence || []).filter(entry => kinds.includes(entry.kind) &&
    Number.isFinite(Date.parse(entry.occurred_at)) && Date.parse(entry.occurred_at) <= now)
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, 3);
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
export function undoReview(lead) {
  const move = automaticMove(lead);
  if (!move || !BOARD_STAGES.some(([key]) => key === move.from)) return null;
  return { stage: move.from, stage_review: { reason: "Undo automatic stage move", evidence_ids: [], undo_event_id: move.event_id } };
}
