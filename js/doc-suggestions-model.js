// B08: the suggestion view model. A card is one obligation, identified by the
// producer. Never deduplicate by title or polished wording.
const choices = new Set(['act', 'discuss', 'snooze', 'dismiss']);
const text = value => typeof value === 'string' ? value.trim() : '';

export function shouldShowSuggestion(row, today = new Date().toISOString().slice(0, 10)) {
  if (!row || !row.id) return false;
  if (row.disposition === 'dismissed' && row.dismissed_material_version === row.material_version) return false;
  if (row.disposition === 'snoozed' && row.snoozed_material_version === row.material_version
      && (!row.snoozed_until || row.snoozed_until > today)) return false;
  return true;
}

export function suggestionCards(payload, { today, includeParked = false } = {}) {
  if (!Array.isArray(payload?.suggestions)) return [];
  return payload.suggestions.filter(row => includeParked || shouldShowSuggestion(row, today)).map(row => ({
    id: row.id, obligationKey: row.obligation_key, version: row.version,
    materialVersion: row.material_version, disposition: row.disposition,
    polished: text(row.polished_text) || text(row.original_text),
    original: text(row.original_text), uncertainty: text(row.uncertainty),
    contributor: text(row.contributor) || 'Unattributed',
    sourceAt: row.source_at || null, suggestedAt: row.suggested_at || null,
    sourceConversationId: row.source_conversation_id || row.conversation_id || null,
    sourceSequence: row.source_sequence ?? null,
    currentRecord: row.current_record || null,
    contributions: (Array.isArray(row.contributions) ? row.contributions : []).map(item => ({
      original: text(item.original_text), contributor: text(item.contributor) || 'Unattributed',
      at: item.at || null,
    })),
    corrections: (Array.isArray(row.corrections) ? row.corrections : []).map(item => ({
      id: item.id, proposedText: text(item.proposed_text), baseVersion: item.base_version,
      proposedAt: item.proposed_at || null, status: item.status,
    })),
  }));
}

export function suggestionReadState(previous, { state, payload = null, sentence = null }) {
  return { ...previous, state, rows: state === 'read' ? payload.suggestions : [],
    coverage: state === 'read' ? payload.coverage ?? null : null, sentence };
}

export function suggestionStatus(read, visibleCount) {
  if (read.state === 'unavailable') return { visible: true, state: 'unavailable', title: read.sentence };
  if (read.state !== 'read') return { visible: true, state: 'loading', title: 'Reading suggestions…' };
  const coverage = read.coverage;
  if (coverage?.state !== 'complete')
    return { visible: true, state: 'unknown', title: 'Suggestion coverage is unknown' };
  if (visibleCount > 0) return { visible: false, state: 'read', title: '' };
  if (coverage.empty_state === 'filtered')
    return { visible: true, state: 'filtered', title: 'Suggestions are hidden by this view' };
  if (coverage.empty_state === 'verified_empty')
    return { visible: true, state: 'empty', title: 'No suggestions need a decision' };
  return { visible: true, state: 'unknown', title: 'Suggestion coverage is unknown' };
}

export function decisionArgs(row, choice, idempotency_key, snoozed_until = null, work_ref = null) {
  if (!row?.id || !Number.isInteger(row.version) || !choices.has(choice)
      || (idempotency_key !== undefined && !text(idempotency_key))) return null;
  if (choice === 'act' && !text(work_ref)) return null;
  return { suggestion_id: row.id, base_version: row.version, choice,
    ...(idempotency_key !== undefined ? { idempotency_key } : {}),
    ...(choice === 'snooze' && snoozed_until ? { snoozed_until } : {}),
    ...(choice === 'act' ? { work_ref: text(work_ref) } : {}) };
}

export function correctionArgs(row, proposed_text, idempotency_key) {
  if (!row?.id || !Number.isInteger(row.version) || !text(proposed_text)
      || (idempotency_key !== undefined && !text(idempotency_key))) return null;
  return { suggestion_id: row.id, base_version: row.version, proposed_text: text(proposed_text),
    source_conversation_id: row.source_conversation_id || row.conversation_id, source_sequence: row.source_sequence,
    ...(idempotency_key !== undefined ? { idempotency_key } : {}) };
}

export function correctionConflict(draft, currentRow, { choice = null, source = 'read', conversationId = null } = {}) {
  return { draft, choice, source,
    conversationId: currentRow?.source_conversation_id || currentRow?.conversation_id || conversationId,
    current: { version: currentRow?.version ?? null,
    polished: text(currentRow?.polished_text), original: text(currentRow?.original_text) } };
}

export function visibleSuggestionConflicts(conflicts, cards, route) {
  const shown = new Set(cards.map(card => card.id));
  return [...conflicts.entries()].filter(([id, conflict]) =>
    !shown.has(id) && (route.state !== 'ok' || conflict.conversationId === route.id));
}

export function reconcileSuggestionConflicts(conflicts, rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return new Map([...conflicts.entries()].map(([id, held]) => {
    const current = byId.get(id);
    return [id, current ? correctionConflict(held.draft, current,
      { choice: held.choice, conversationId: held.conversationId }) : held];
  }));
}

export function suggestionFlow() {
  return [
    { id: 'original', label: 'Original' },
    { id: 'suggestion', label: 'Suggestion' },
    { id: 'decision', label: 'Your decision' },
    { id: 'result', label: 'Work or proposal' },
  ];
}
