const RECENT_MS = 24 * 60 * 60 * 1000;
const LIVE_MS = 10 * 60 * 1000;

export function timeOf(turn) {
  const value = Date.parse(turn?.at || "");
  return Number.isFinite(value) ? value : 0;
}

export function labelFor(turn) {
  const seat = String(turn?.seat || "system").toLowerCase();
  if (seat === "human") {
    if (turn?.sponsor === "joe") return "Joe";
    if (turn?.sponsor === "dell") return "Dell";
    return "Partner";
  }
  return ({ codex: "Codex", sol: "Sol", claude: "Claude", opus: "Opus",
    sonnet: "Sonnet", hermes: "Hermes", grok: "Grok", flash: "Flash" })[seat]
    || seat.charAt(0).toUpperCase() + seat.slice(1);
}

export function modelFor(turn) {
  if (String(turn?.seat).toLowerCase() === "human") return "Human";
  if (typeof turn?.model === "string" && turn.model.trim()) return turn.model.trim();
  try {
    const parsed = JSON.parse(turn.body);
    if (typeof parsed?.model === "string" && parsed.model.trim()) return parsed.model.trim();
  } catch { /* plain dialogue */ }
  return "Model unrecorded";
}

function explicitThreadKey(turn) {
  const body = String(turn?.body || "");
  try {
    const value = JSON.parse(body);
    for (const key of ["thread_id", "conversation_id", "work_request_id", "task_id"]) {
      if (typeof value?.[key] === "string" && value[key].trim()) return `${key}:${value[key].toLowerCase()}`;
    }
    for (const record of [value?.queue_completion, value?.queue_event, value?.assignment]) {
      if (typeof record?.task_id === "string") return `task_id:${record.task_id.toLowerCase()}`;
    }
  } catch { /* plain dialogue */ }
  const work = body.match(/\bWR[- ]?0*(\d{1,6})\b/i);
  if (work) return `wr-${work[1].padStart(6, "0")}`;
  const task = body.match(/\btask[_ -]?id[=: ]+(t_[a-z0-9]+)\b/i);
  if (task) return `task_id:${task[1].toLowerCase()}`;
  const queue = body.match(/(?:^|\s)key=([a-z0-9][a-z0-9-]+)/i);
  if (queue) return `queue:${queue[1].toLowerCase()}`;
  return null;
}

export function threadKey(turn) {
  return explicitThreadKey(turn) || `turn:${turn?.msg_id || turn?.seq}`;
}

function titleFor(turn, key) {
  const body = String(turn.body || "").trim();
  const text = body.includes("::") ? body.split("::").slice(1).join("::").trim() : body;
  if (text.startsWith("{")) return key.replace(/^(task_id|thread_id|conversation_id):/, "Thread ");
  return (text.split(/[\n.!?]/)[0] || key).slice(0, 92);
}

export function groupConversations(turns) {
  const groups = new Map();
  let activeKey = null;
  for (const turn of [...turns].filter((row) => row?.kind === "turn")
    .sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const explicitKey = explicitThreadKey(turn);
    const human = String(turn.seat).toLowerCase() === "human";
    const key = explicitKey || (human ? threadKey(turn) : activeKey || threadKey(turn));
    if (human) activeKey = key;
    let group = groups.get(key);
    if (!group) {
      group = { key, title: titleFor(turn, key), turns: [], participants: [],
        firstAt: turn.at, lastAt: turn.at, turnCount: 0 };
      groups.set(key, group);
    }
    group.turns.push(turn);
    group.turnCount += 1;
    group.lastAt = turn.at;
    const speaker = labelFor(turn);
    if (!group.participants.includes(speaker)) group.participants.push(speaker);
  }
  return [...groups.values()].sort((a, b) => timeOf({ at: b.lastAt }) - timeOf({ at: a.lastAt }));
}

function receipt(turn) {
  if (turn?.kind !== "receipt") return null;
  try { return JSON.parse(turn.body); } catch { return null; }
}

export function summarizeNow(turns, now = Date.now()) {
  const ordered = [...turns].sort((a, b) => Number(b.seq) - Number(a.seq));
  const activeSessions = new Map();
  const attention = [];
  const finished = [];
  let heartbeat = null;
  for (const turn of ordered) {
    const item = receipt(turn);
    if (!item) continue;
    if (!heartbeat && item.heartbeat) heartbeat = { ...item.heartbeat, at: turn.at };
    const presence = item.session_presence;
    if (presence?.handle && !activeSessions.has(presence.handle)) {
      activeSessions.set(presence.handle, { ...presence, at: turn.at });
    }
    const completion = item.queue_completion || item.worker_completed;
    if (completion && now - timeOf(turn) <= RECENT_MS && finished.length < 5) {
      finished.push({ ...completion, at: turn.at, seat: labelFor(turn) });
    }
    const failure = item.assignment_rejected || item.control_refused || item.queue_failure
      || (item.session_delivery && !["delivered", "accepted"].includes(item.session_delivery.status)
        ? item.session_delivery : null);
    if (failure && now - timeOf(turn) <= RECENT_MS && attention.length < 5) {
      attention.push({ ...failure, at: turn.at, seat: labelFor(turn) });
    }
  }
  const fromHeartbeat = heartbeat?.sessions || [];
  for (const row of fromHeartbeat) {
    if (row?.handle && !activeSessions.has(row.handle)) activeSessions.set(row.handle, row);
  }
  const running = [...activeSessions.values()].filter((row) => {
    const beat = Date.parse(row.beat_at || row.last_live_at || row.at || "");
    return row.event !== "depart" && row.live !== false && Number.isFinite(beat) && now - beat <= LIVE_MS;
  }).sort((a, b) => Date.parse(b.beat_at || b.last_live_at || b.at) - Date.parse(a.beat_at || a.last_live_at || a.at));
  return {
    running: running.slice(0, 8), attention, finished,
    latestTurns: ordered.filter((turn) => turn.kind === "turn" && now - timeOf(turn) <= RECENT_MS).slice(0, 4),
    heartbeat, latestAt: ordered[0]?.at || null,
  };
}
