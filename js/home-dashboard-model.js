import { visibleLeads } from './leads-model.js';
import { localDeals, scopedDeals, validDealBoard } from './deal-review-model.js';
import { validInvoiceTracker } from './invoice-tracker-model.js';
import { validNetwork } from './relationship-network-model.js';
import { criticalDateEntries, localToday, toDay } from './calendar-model.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { readHomeCallFollowups } from './home-call-tasks.js';

export const HOME_SCOPES = ['team', 'mine'];
export const HIDDEN_HOME_WIDGETS = Object.freeze({
  vendors: 'New vendor prospects with compatibility evidence',
  listings: 'Fresh client/listing matches with listing URL, agent contact and authorized attachments',
  capture: 'Doc task/idea classification and document-now/table workflow',
});

// Validate the fields Home needs to identify complete feeds. Missing ranking
// evidence can leave an identified lead unranked; missing rows or identities
// cannot establish an empty feed or a count.
const validHomeRows = (payload, key) => payload && typeof payload === 'object' && !Array.isArray(payload)
  && Array.isArray(payload[key]) && payload[key].every(row => row && typeof row === 'object' && !Array.isArray(row)
    && typeof row.id === 'string' && row.id.trim().length > 0);

export function dealSnapshot(board, scope = 'team', agenda) {
  const deals = scopedDeals(board, scope);
  if (!deals) return null;
  const local = localDeals(deals);
  // Entries arrive oldest first, so the first one per deal is how long it has waited.
  const overdue = new Map();
  for (const entry of agenda?.overdue || []) if (!overdue.has(entry.deal_id)) overdue.set(entry.deal_id, entry.day);
  const complete = agenda && !local.some(deal => agenda.failed.includes(deal.id));
  return { active: deals.length,
    // No current contract supplies in-market membership. Neither city nor
    // pipeline stage is evidence of it; the UI retains an unknown value.
    inMarket: deals.every(deal => typeof deal.in_market === 'boolean')
      ? deals.filter(deal => deal.in_market).length : null,
    national: deals.filter(deal => deal.workspace_kind === 'national_account' || deal.account_client_id).length,
    flagged: complete ? local.filter(deal => overdue.has(deal.id)).map(deal => ({ ...deal, overdue_since: overdue.get(deal.id) }))
      .sort((a, b) => a.overdue_since.localeCompare(b.overdue_since)) : local.length ? null : [] };
}

export function dealHref(id) { return `/deals?deal=${encodeURIComponent(id)}`; }

export function topNewLeads(payload, { scope = 'team', actor, now = Date.now() } = {}) {
  if (!Array.isArray(payload?.leads) || (scope === 'mine' && !actor)) return [];
  return visibleLeads(payload.leads.filter(lead => lead && typeof lead.id === 'string')).map(lead => ({ ...lead, score: typeof lead.score === 'string' && /^-?\d+(?:\.\d+)?$/.test(lead.score) ? Number(lead.score) : lead.score })).filter(lead => typeof lead.score === 'number' && Number.isFinite(lead.score)
    && Number.isFinite(Date.parse(lead.created_at))
    && Date.parse(lead.created_at) >= now - 7 * 86_400_000 && Date.parse(lead.created_at) <= now
    && (scope !== 'mine' || lead.owner === actor))
    .sort((a, b) => b.score - a.score || Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id))
    .slice(0, 3);
}

export function agendaSnapshot(board, details, { scope = 'team', today = localToday() } = {}) {
  const deals = scopedDeals(board, scope);
  if (!deals) return null;
  const entries = [], briefTasks = [], failed = [], undated = [];
  for (const deal of deals) {
    const detail = details.get(deal.id);
    if (!detail || !Array.isArray(detail.critical_dates) || !Array.isArray(detail.next_actions)) { failed.push(deal.id); continue; }
    const isRow = row => row && typeof row === 'object' && !Array.isArray(row);
    const dateRows = detail.critical_dates.filter(isRow);
    const taskRows = detail.next_actions.filter(row => isRow(row) && typeof row.id === 'string' && typeof row.status === 'string');
    if (dateRows.length !== detail.critical_dates.length || taskRows.length !== detail.next_actions.length) failed.push(deal.id);
    const dates = criticalDateEntries(deal, { critical_dates: dateRows });
    undated.push(...dates.undated);
    entries.push(...dates.entries.filter(entry => !entry.settled).map(entry => ({ ...entry, type: 'date' })));
    for (const task of taskRows) {
      const day = toDay(task.due_on);
      if (task.status !== 'open' || (scope === 'mine' && task.owner !== board.actor)) continue;
      const entry = { key: `task:${task.id}`, deal_id: deal.id, deal_name: deal.name, day, owner: task.owner, label: task.description || 'Task', type: 'task' };
      briefTasks.push(entry);
      if (!(toDay(task.hold_until) > today)) entries.push(entry);
    }
  }
  const priority = entry => !entry.day ? 1 : entry.day <= today ? 0 : 2;
  const order = (a, b) => priority(a) - priority(b) || (a.day || '').localeCompare(b.day || '') || a.key.localeCompare(b.key);
  entries.sort(order); briefTasks.sort(order);
  return { entries, briefTasks, failed, undated, upcoming: entries, dueToday: entries.filter(entry => entry.day === today), overdue: entries.filter(entry => entry.day && entry.day < today) };
}

// A single bounded snapshot supplies flags, dates and tasks. Slow or failed optional
// data never prevents the deals from arriving. Every read has a deadline.
export function readHomeDashboard(client, options) {
  return readHome(client, [
    ['invoices', signal => client.getInvoiceTracker({ signal })],
    ['leads', signal => client.getLeadBoard({ signal })],
    ['relationships', signal => client.getRelationshipNetwork({ signal })],
    ['callTasks', signal => readHomeCallFollowups(client, { signal })],
  ], options);
}

export function readHomeAgenda(client, options) {
  return readHome(client, [], options);
}

async function readHome(client, feeds, { onUpdate = () => {}, timeoutMs = 10_000, signal } = {}) {
  const result = { board: null, details: new Map(), leads: null, invoices: null, relationships: null, callTasks: null, unauthorized: false, updatedAt: null, loading: true,
    reads: Object.fromEntries(['board', ...feeds.map(([key]) => key)].map(key => [key, { state: 'loading' }])) };
  const publish = () => onUpdate(result);
  const take = async (name, read) => {
    try {
      if (signal?.aborted) return;
      const value = await readWithDeadline(read, { timeoutMs, signal });
      if (name === 'invoices' && !validInvoiceTracker(value)) throw Object.assign(new Error('Invoices unavailable'), {code:'invalid_payload'});
      if (name === 'relationships' && (!validNetwork(value) || Date.parse(value.valid_until) <= Date.now())) throw Object.assign(new Error('Relationships unavailable'), {code:'invalid_payload'});
      if ((name === 'board' && (!validDealBoard(value) || value.schema_version !== 'home-agenda.v1' || typeof value.actor !== 'string' || !value.actor.trim() || new Set(value.deals.map(deal => deal.id)).size !== value.deals.length)) || (name === 'leads' && !validHomeRows(value, 'leads'))) {
        const error = new Error('Home board unavailable');
        error.code = 'malformed_response';
        throw error;
      }
      result[name] = value;
      result.reads[name] = { state: 'read' };
      if (name === 'board') {
        for (const deal of scopedDeals(value, 'team') || []) result.details.set(deal.id, deal);
      }
      result.updatedAt = new Date().toISOString();
    }
    catch (error) { result[name] = null;
      result.reads[name] = { state: 'error', code: error?.code || 'unavailable' };
      if ([401, 403].includes(error?.status)) result.unauthorized = true; }
    publish();
  };
  const board = take('board', signal => client.getHomeAgenda({ signal }));
  await Promise.all([board, ...feeds.map(([key, read]) => take(key, read))]);
  result.loading = false;
  publish();
  return result;
}
