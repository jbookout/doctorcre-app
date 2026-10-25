import { visibleLeads } from './leads-model.js';
import { localDeals, needsAttention, scopedDeals, validDealBoard } from './deal-review-model.js';
import { validInvoiceTracker } from './invoice-tracker-model.js';
import { validNetwork } from './relationship-network-model.js';
import { addDays, criticalDateEntries, localToday, toDay } from './calendar-model.js';
import { validIncidentBoardPayload, validCurrentWorkItemPayload, validCurrentWorkRequestsPayload, STUCK_SILENCE_HOURS } from './control-room-model.js';
import { validScheduleBoardPayload } from './operations-model.js';
import { projectResourceDashboard } from './resource-dashboard-model.js';
import { readWithDeadline } from './auto-refresh.mjs';

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

export function dealSnapshot(board, scope = 'team', now = Date.now()) {
  const deals = scopedDeals(board, scope);
  if (!deals) return null;
  return { active: deals.length,
    // No current contract supplies in-market membership. Neither city nor
    // pipeline stage is evidence of it; the UI retains an unknown value.
    inMarket: deals.every(deal => typeof deal.in_market === 'boolean')
      ? deals.filter(deal => deal.in_market).length : null,
    national: deals.filter(deal => deal.workspace_kind === 'national_account' || deal.account_client_id).length,
    flagged: localDeals(deals).filter(deal => needsAttention(deal, now)) };
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
  const entries = [], failed = [], undated = [];
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
      if (task.status !== 'open' || toDay(task.hold_until) > today || (scope === 'mine' && task.owner !== board.actor)) continue;
      entries.push({ key: `task:${task.id}`, deal_id: deal.id, deal_name: deal.name, day, owner: task.owner, label: task.description || 'Task', type: 'task' });
    }
  }
  const priority = entry => !entry.day ? 1 : entry.day <= today ? 0 : 2;
  entries.sort((a, b) => priority(a) - priority(b) || (a.day || '').localeCompare(b.day || '') || a.key.localeCompare(b.key));
  const week = Array.from({ length: 7 }, (_, i) => ({ day: addDays(today, i), entries: entries.filter(entry => entry.day === addDays(today, i)) }));
  return { entries, week, failed, undated, upcoming: entries };
}

export function controlSnapshot(reads) {
  const { incidents, work, requests, resources, schedule } = reads;
  if (!Object.keys(reads).length) return null;
  const incidentCount = validIncidentBoardPayload(incidents) ? incidents.count : 0;
  const complete = validIncidentBoardPayload(incidents) && validCurrentWorkItemPayload(work) && validCurrentWorkRequestsPayload(requests)
    && validScheduleBoardPayload(schedule) && schedule.sources.every(row => row.state === 'read')
    && schedule.overall_state === 'read'
    && schedule.jobs.every(job => job.freshness === 'fresh' && ['healthy', 'running', 'paused'].includes(job.state))
    && projectResourceDashboard(resources).providers.every(row => row.state === 'ok' && row.observed_at);
  const stalled = validCurrentWorkItemPayload(work) ? work.current.filter(item => item.hours_since_last_change >= STUCK_SILENCE_HOURS || ['blocked', 'needs_joe'].includes(item.state)).length : 0;
  const waiting = validCurrentWorkRequestsPayload(requests) ? requests.items.filter(item => item.state === 'needs_joe'
    || (['captured', 'triaged', 'ready'].includes(item.state) && item.next_human_action?.trim())).length : 0;
  const scheduledIssues = validScheduleBoardPayload(schedule) ? schedule.jobs.filter(job => ['missed', 'failed'].includes(job.state)).length : 0;
  const wipIssues = validCurrentWorkItemPayload(work) ? Number(work.wip.over_system_limit === true)
    + (Array.isArray(work.wip.executors_over_limit) ? work.wip.executors_over_limit.length : 0) : 0;
  const issues = incidentCount + stalled + waiting + scheduledIssues + wipIssues;
  return { attention: issues > 0 || !complete,
    line: incidentCount ? `${incidentCount} open ${incidentCount === 1 ? 'issue' : 'issues'}`
      : stalled ? `${stalled} ${stalled === 1 ? 'item needs' : 'items need'} a decision`
      : waiting ? `${waiting} ${waiting === 1 ? 'request awaits' : 'requests await'} a decision`
      : wipIssues ? 'Work exceeds its limits'
      : scheduledIssues ? 'Scheduled work needs attention' : !complete ? 'Status checks incomplete' : 'No open issues',
    issues, complete };
}

// A single bounded snapshot supplies flags, dates and tasks. Slow or failed optional
// data never prevents the deals from arriving. Every read has a deadline.
export function readHomeDashboard(client, options) {
  return readHome(client, [
    ['invoices', signal => client.getInvoiceTracker({ signal })],
    ['leads', signal => client.getLeadBoard({ signal })],
    ['relationships', signal => client.getRelationshipNetwork({ signal })],
    ['incidents', signal => client.incidentBoard({ state: 'open', limit: 1000 }, { signal }), 'control'],
    ['work', signal => client.currentWorkItem({ signal }), 'control'],
    ['requests', signal => client.currentWorkRequests({ signal }), 'control'],
    ['resources', signal => client.readResourceDashboard({ signal }), 'control'],
    ['schedule', signal => client.scheduleBoard({ signal }), 'control'],
  ], options);
}

export function readHomeAgenda(client, options) {
  return readHome(client, [], options);
}

async function readHome(client, feeds, { onUpdate = () => {}, timeoutMs = 10_000, signal } = {}) {
  const result = { board: null, details: new Map(), leads: null, invoices: null, relationships: null, control: {}, unauthorized: false, updatedAt: null, loading: true,
    reads: Object.fromEntries(['board', ...feeds.map(([key]) => key)].map(key => [key, { state: 'loading' }])) };
  const publish = () => onUpdate(result);
  const take = async (name, read, target = result) => {
    try {
      if (signal?.aborted) return;
      const value = await readWithDeadline(read, { timeoutMs, signal });
      if (name === 'invoices' && !validInvoiceTracker(value)) throw Object.assign(new Error('Invoices unavailable'), {code:'invalid_payload'});
      if (name === 'relationships' && (!validNetwork(value) || Date.parse(value.valid_until) <= Date.now())) throw Object.assign(new Error('Relationships unavailable'), {code:'invalid_payload'});
      if (target === result && ((name === 'board' && (!validDealBoard(value) || value.schema_version !== 'home-agenda.v1' || typeof value.actor !== 'string' || !value.actor.trim() || new Set(value.deals.map(deal => deal.id)).size !== value.deals.length)) || (name === 'leads' && !validHomeRows(value, 'leads')))) {
        const error = new Error('Home board unavailable');
        error.code = 'malformed_response';
        throw error;
      }
      target[name] = value;
      result.reads[name] = { state: 'read' };
      if (name === 'board' && target === result) {
        for (const deal of scopedDeals(value, 'team') || []) result.details.set(deal.id, deal);
      }
      result.updatedAt = new Date().toISOString();
    }
    catch (error) { target[name] = null;
      result.reads[name] = { state: 'error', code: error?.code || 'unavailable' };
      if ([401, 403].includes(error?.status)) result.unauthorized = true; }
    publish();
  };
  const board = take('board', signal => client.getHomeAgenda({ signal }));
  await Promise.all([board, ...feeds.map(async ([key, read, target]) => {
    if (key === 'invoices') await board;
    return take(key, read, target === 'control' ? result.control : result);
  })]);
  result.loading = false;
  publish();
  return result;
}
