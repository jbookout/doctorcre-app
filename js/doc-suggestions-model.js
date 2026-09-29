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

export function correctionConflict(draft, currentRow) {
  return { draft, current: { version: currentRow?.version ?? null,
    polished: text(currentRow?.polished_text), original: text(currentRow?.original_text) } };
}

export function suggestionFlow() {
  return [
    { id: 'original', label: 'Original' },
    { id: 'suggestion', label: 'Suggestion' },
    { id: 'decision', label: 'Your decision' },
    { id: 'result', label: 'Work or proposal' },
  ];
}
