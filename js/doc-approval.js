import { readWithDeadline } from './auto-refresh.mjs';
import { contextualSuggestions } from './doc-context-model.js';

// This slice records a discussion decision. It never interprets a suggestion
// as an executable command, sends correspondence, or claims task completion.
export function createDocApproval({ client, context, evaluatedPages, uuid }) {
  const intents = new Map();
  let busy = false;
  const eligible = (row, snapshot, payload) => contextualSuggestions(snapshot, { ...payload, suggestions:[row] }, { evaluatedPages }).length === 1;
  return {
    get busy() { return busy; },
    async approve(row, shownPayload) {
      const shown = context.snapshot();
      if (busy || !eligible(row, shown, shownPayload)) return { state: 'changed' };
      const signature = `${row.id}:${row.version}`;
      const pending = intents.get(signature);
      if (pending?.state === 'unknown') return { state: 'unknown' }; // no blind replay
      const intent = pending || { key: uuid(), state: 'pending' };
      intents.set(signature, intent); busy = true; let writing = false;
      try {
        const args = shown.page === 'chats' && shown.selected ? { conversation_id: shown.selected.id } : {};
        const latest = await readWithDeadline(() => client.listDocSuggestions(args));
        const current = context.snapshot();
        const fresh = latest?.suggestions?.find(item => item.id === row.id && item.version === row.version);
        if (current.epoch !== shown.epoch || JSON.stringify(current.selected) !== JSON.stringify(shown.selected)
          || !fresh || !eligible(fresh, current, latest) || ['polished_text','original_text','uncertainty','material_facts'].some(key => JSON.stringify(fresh[key]) !== JSON.stringify(row[key]))) return { state: 'changed' };
        // The only write is a human decision on the immutable suggestion version.
        writing = true;
        const result = await readWithDeadline(() => client.decideDocSuggestion({ suggestion_id: row.id, base_version: row.version,
          choice: 'discuss', idempotency_key: intent.key }));
        if (result?.ok !== true || result.suggestion_id !== row.id || result.choice !== 'discuss'
          || result.version !== row.version + 1) { intent.state = 'unknown'; return { state: 'unknown' }; }
        intent.state = 'approved'; return { state: 'approved', receipt: result };
      } catch (error) {
        if ([401,403].includes(error.status)) context.clear();
        if (!writing) { intents.delete(signature); return { state:'unavailable' }; }
        if (error.code === 'version_conflict') return { state: 'changed' };
        intent.state = 'unknown'; return { state: 'unknown' };
      } finally { busy = false; }
    },
    reconcile(payload) {
      for (const [signature, intent] of intents) {
        if (intent.state !== 'unknown') continue;
        const [id, version] = signature.split(':');
        const row = payload?.suggestions?.find(item => item.id === id);
        if (row?.disposition === 'discuss' && row.version > Number(version)) intent.state = 'approved';
      }
    },
  };
}
