import { addDays, criticalDateEntries, localToday, toDay } from './calendar-model.js';
import { validIncidentBoardPayload, validCurrentWorkItemPayload, validCurrentWorkRequestsPayload, STUCK_SILENCE_HOURS } from './control-room-model.js';
import { validScheduleBoardPayload } from './operations-model.js';
import { projectResourceDashboard } from './resource-dashboard-model.js';
import { readWithDeadline } from './auto-refresh.mjs';

export const HOME_SCOPES = ['team', 'mine'];
export const HIDDEN_HOME_WIDGETS = Object.freeze({
  pastClients: 'Past-client follow-up moments, executed lease expiry through 24 calendar months, owner and contact holds',
  vendors: 'Ranked introduction suggestions and new vendor prospects with compatibility evidence',
  listings: 'Fresh client/listing matches with listing URL, agent contact and authorized attachments',
  capture: 'Doc task/idea classification and document-now/table workflow',
});

export function scopedDeals(board, scope) {
  if (!Array.isArray(board?.deals) || (scope === 'mine' && !board.actor)) return null;
  return board.deals.filter(deal => deal && typeof deal.id === 'string'
    && !['closed', 'Closed'].includes(deal.phase)
    && (deal.operating_state || 'active') === 'active'
    && (scope !== 'mine' || deal.owner === board.actor));
}

export function dealSnapshot(board, scope = 'team') {
  const deals = scopedDeals(board, scope);
  if (!deals) return null;
  return { active: deals.length,
    // No current contract supplies in-market membership. Neither city nor
    // pipeline stage is evidence of it; the UI retains an unknown value.
    inMarket: deals.every(deal => typeof deal.in_market === 'boolean')
      ? deals.filter(deal => deal.in_market).length : null,
    national: deals.filter(deal => deal.workspace_kind === 'national_account' || deal.account_client_id).length,
    flagged: deals.filter(deal => deal.attention === true) };
}

export function dealHref(id) { return `/deals?deal=${encodeURIComponent(id)}`; }

export function topNewLeads(payload, { scope = 'team', actor, now = Date.now() } = {}) {
  if (!Array.isArray(payload?.leads) || (scope === 'mine' && !actor)) return [];
  return payload.leads.filter(lead => typeof lead?.id === 'string'
    && typeof lead.score === 'number' && Number.isFinite(lead.score)
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
    const dates = criticalDateEntries(deal, detail);
    undated.push(...dates.undated);
    entries.push(...dates.entries.filter(entry => !entry.settled).map(entry => ({ ...entry, type: 'date' })));
    for (const task of detail.next_actions) {
      const day = toDay(task.due_on);
      if (task.status !== 'open' || (scope === 'mine' && task.owner !== board.actor)) continue;
      if (!day) { undated.push(task); continue; }
      entries.push({ key: `task:${task.id}`, deal_id: deal.id, deal_name: deal.name, day, label: task.description || 'Task', type: 'task' });
    }
  }
  entries.sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
  const week = Array.from({ length: 7 }, (_, i) => ({ day: addDays(today, i), entries: entries.filter(entry => entry.day === addDays(today, i)) }));
  return { entries, week, failed, undated, upcoming: entries.slice(0, 4) };
}

export function controlSnapshot(reads) {
  const { incidents, work, requests, resources, schedule } = reads;
  if (!validIncidentBoardPayload(incidents)) return null;
  const complete = validCurrentWorkItemPayload(work) && validCurrentWorkRequestsPayload(requests)
    && validScheduleBoardPayload(schedule) && schedule.sources.every(row => row.state === 'read')
    && schedule.overall_state === 'read'
    && schedule.jobs.every(job => job.freshness === 'fresh' && ['healthy', 'running', 'paused'].includes(job.state))
    && projectResourceDashboard(resources).providers.every(row => row.state === 'ok' && row.observed_at);
  const stalled = validCurrentWorkItemPayload(work) ? work.current.filter(item => item.hours_since_last_change >= STUCK_SILENCE_HOURS || ['blocked', 'needs_joe'].includes(item.state)).length : 0;
  const waiting = validCurrentWorkRequestsPayload(requests) ? requests.items.filter(item => item.state === 'needs_joe').length : 0;
  const scheduledIssues = validScheduleBoardPayload(schedule) ? schedule.jobs.filter(job => ['missed', 'failed'].includes(job.state)).length : 0;
  const issues = incidents.count + stalled + waiting + scheduledIssues;
  return { attention: issues > 0 || !complete,
    line: incidents.count ? `${incidents.count} open ${incidents.count === 1 ? 'issue' : 'issues'}`
      : stalled ? `${stalled} ${stalled === 1 ? 'item needs' : 'items need'} a decision`
      : waiting ? `${waiting} ${waiting === 1 ? 'request awaits' : 'requests await'} a decision`
      : scheduledIssues ? 'Scheduled work needs attention' : !complete ? 'Status checks incomplete' : 'Everything is clear',
    issues, complete };
}

// A single board snapshot supplies flags and agenda. Slow or failed optional
// data never prevents the deals from arriving. Every read has a deadline.
export async function readHomeDashboard(client, { onUpdate = () => {}, timeoutMs = 10_000, signal } = {}) {
  const result = { board: null, details: new Map(), leads: null, control: {}, unauthorized: false, updatedAt: null };
  const publish = () => onUpdate(result);
  const take = async (name, read, target = result) => {
    try {
      if (signal?.aborted) return;
      const value = await readWithDeadline(read, { timeoutMs, signal });
      if (target instanceof Map) target.set(name, value); else target[name] = value;
      result.updatedAt = new Date().toISOString();
    }
    catch (error) { if (target instanceof Map) target.set(name, null); else target[name] = null; if ([401, 403].includes(error?.status)) result.unauthorized = true; }
    publish();
  };
  const board = take('board', () => client.getBoard({ workspace: 'all' })).then(async () => {
    const deals = scopedDeals(result.board, 'team') || [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, deals.length) }, async () => {
      while (next < deals.length && !result.unauthorized && !signal?.aborted) {
        const deal = deals[next++];
        await take(deal.id, () => client.getDeal(deal.id), result.details);
      }
    }));
  });
  await Promise.all([board, take('leads', () => client.getLeadBoard()),
    ...[['incidents', () => client.incidentBoard({ state: 'open', limit: 1000 })],
      ['work', () => client.currentWorkItem()], ['requests', () => client.currentWorkRequests()],
      ['resources', () => client.readResourceDashboard()], ['schedule', () => client.scheduleBoard()]]
      .map(([key, read]) => take(key, read, result.control))]);
  return result;
}
