import { randomUUID } from "node:crypto";
class ToolError extends Error {
  constructor(fields) { super(fields.error); Object.assign(this, fields); }
}

const CONVERSATION = "5b1c0a52-0000-4000-8000-000000000001";
const JOE_ASK = "5b1c0a52-0000-4000-8000-0000000000a1";
const DELL_ASK = "5b1c0a52-0000-4000-8000-0000000000a2";
const ANSWER = "5b1c0a52-0000-4000-8000-0000000000b1";
const EARLIER_ANSWER = "5b1c0a52-0000-4000-8000-0000000000b0";

export function store(docConversationTools) {
  const turns = [
    { msg_id: EARLIER_ANSWER, sequence: 0, role: "assistant", origin_actor: "claude" },
    { msg_id: JOE_ASK, sequence: 1, role: "human", origin_actor: "joe" },
    { msg_id: DELL_ASK, sequence: 2, role: "human", origin_actor: "dell" },
    { msg_id: ANSWER, sequence: 3, role: "assistant", origin_actor: "claude" },
  ];
  const events = [];
  const notifications = [];
  const c = {
    async query(text, values = []) {
      if (text.includes("from ops.doc_conversation_turn")) {
        const row = values[0] === CONVERSATION ? turns.find(t => t.msg_id === values[1]) : undefined;
        return { rows: row ? [row] : [] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("from event where")) {
        const hit = events.find(e => e.new.request_msg_id === values[1]);
        return { rows: hit ? [{ id: hit.id, new_value: hit.new }] : [] };
      }
      if (text.includes("ops.mint_notification")) {
        const [source, eventRef, subjectType, subjectRef, reason, severity, deepLink, dedupeKey, slug, bypass, hold] = values;
        const prior = notifications.find(n => n.recipient === slug && n.dedupe_key === dedupeKey);
        if (prior) return { rows: [{ result: { ok: true, minted: false, deduplicated: true, notification_id: prior.id } }] };
        const row = { id: randomUUID(), recipient: slug, source, eventRef, subjectType, subjectRef,
          reason, severity, deep_link: deepLink, dedupe_key: dedupeKey, bypass, hold };
        notifications.push(row);
        return { rows: [{ result: { ok: true, minted: true, notification_id: row.id } }] };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  const envelopes = new Map();
  const tools = docConversationTools({
    ToolError,
    withEnvelope: async (_c, _actor, verb, args, fn) => {
      const key = `${verb}:${args.idempotency_key}`;
      if (envelopes.has(key)) return envelopes.get(key);
      const value = await fn();
      envelopes.set(key, value);
      return value;
    },
    writeEvent: async (_c, _actor, verb, subjectType, subjectId, fields) => {
      events.push({ id: randomUUID(), verb, subjectType, subjectId, ...fields });
    },
  });
  const complete = args => tools["complete-doc-request"].handler(c, { id: "a" },
    { idempotency_key: randomUUID(), conversation_id: CONVERSATION, ...args });
  return { notifications, events, complete };
}


export { CONVERSATION, JOE_ASK, ANSWER };
