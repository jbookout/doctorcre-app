import { commandResults, interpretCommand } from './doc-command-model.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { localToday, isCalendarDay } from './calendar-model.js';
import { PHASES, phaseLabel } from './client.js';
import { createPlannerClient, validateTourList } from '../tours/planner-client.js';
import { scopedDeals } from './home-dashboard-model.js';
import { validInvoiceTracker, invoiceMoney } from './invoice-tracker-model.js';
import { validSearchPayload } from './search-model.js';
import { performCommand } from './command-feedback.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const KIND = { page:['▤','Page'], deal:['▦','Deal'], lead:['◎','Lead'], client:['◉','Client'], vendor:['♧','Vendor'], party:['◌','Person'], tour:['◇','Tour'], move:['✦','Move'], paid:['✦','Payment'], plan:['✦','Tour plan'] };
const day = value => new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
const money = value => invoiceMoney(value == null ? null : Number(value));
const operationFor = action => action.verb === 'move' ? `phase:${action.deal}` : `payment:${action.commission_id}`;
const argsFor = action => action.verb === 'move'
  ? { deal:action.deal, field:'phase', value:action.to, base_event_id:action.base_event_id }
  : { commission_id:action.commission_id, base_version:action.base_version, received_on:action.received_on };
const authorizationFailure = error => [401,403].includes(Number(error?.status)) || error?.code === 'authentication_required' || error?.payload?.error === 'authentication_required';
const validRecovery = entry => {
  const r = entry?.request, a = entry?.action;
  if (!r || !a || typeof r.idempotency_key !== 'string' || !r.idempotency_key || typeof a.name !== 'string' || entry.operationKey !== operationFor(a)) return false;
  return a.verb === 'move' ? typeof r.deal === 'string' && r.deal === a.deal && r.field === 'phase' && PHASES.includes(r.value) && r.value !== 'Closed'
    && (r.base_event_id === null || typeof r.base_event_id === 'string') && r.value === a.to
    : a.verb === 'paid' && typeof r.commission_id === 'string' && r.commission_id === a.commission_id && Number.isInteger(r.base_version) && r.base_version > 0 && isCalendarDay(r.received_on);
};

// One read generation owns all sources. The shared command kernel owns write
// settlement; this controller retains its immutable requests in the tab until
// an explicit outcome check settles them. Reads never replay writes.
export function mountDocCommand({ dialog, getClient, pages = [], uuid, navigate, afterWrite, planner = createPlannerClient(), writeTimeoutMs = 10_000 }) {
  const $ = id => dialog.querySelector(`#${id}`), win = dialog.ownerDocument.defaultView;
  const input = $('docAsk'), list = $('docResults'), staged = $('docStaged'), status = $('docCommandStatus');
  const sources = { deals:[], invoices:[], tours:[] }, states = { deals:'loading', invoices:'loading', tours:'loading', find:'empty' };
  let parties = null, partyQuery = '', rows = [], active = -1, identities = '', pending = null, busy = false, notice = '', disposed = false;
  let findTimer = 0, findEpoch = 0, readEpoch = 0, sessionEpoch = 0, interaction = 0, readController, findController, scope = '', store = '', commands = {}, actions = {};
  const listeners = [];
  function on(node, type, handler) { node.addEventListener(type, handler); listeners.push(() => node.removeEventListener(type, handler)); }
  function unstage() { pending = null; staged.hidden = true; staged.replaceChildren(); }
  function invalidate(message = 'Sign in to continue.') {
    ++sessionEpoch; ++readEpoch; ++findEpoch; ++interaction;
    readController?.abort(); findController?.abort(); win.clearTimeout(findTimer);
    for (const key of Object.keys(sources)) { sources[key] = []; states[key] = 'refused'; }
    parties = null; partyQuery = ''; states.find = 'refused'; active = -1; unstage(); input.value = '';
    try { if (store) win.sessionStorage.removeItem(store); } catch { /* Writes remain disabled when recovery storage is unavailable. */ }
    commands = {}; actions = {}; scope = ''; store = ''; notice = message; render();
  }
  function retainScope(client, actor) {
    const next = `${client.mode}:${actor || client.selfActor || ''}:${client.scope || planner.scope || ''}`;
    if (scope && next !== scope) { invalidate('Session changed. Open Doc to continue.'); return false; }
    if (scope) return true;
    scope = next; store = `doctorcre:doc-commands:v1:${next}`;
    const saved = JSON.parse(win.sessionStorage.getItem(store) || '[]');
    if (!Array.isArray(saved) || !saved.every(validRecovery)) throw new Error('Invalid command recovery');
    for (const entry of saved) { commands[entry.operationKey] = { ...entry, status:'unknown' }; actions[entry.operationKey] = entry.action; }
    return true;
  }
  function saveCommands(next) {
    // Persist before dispatch, including pending writes: a navigation during a
    // send must restore an unknown request, never mint a replacement key.
    win.sessionStorage.setItem(store, JSON.stringify(Object.entries(next).map(([operationKey,entry]) => ({ operationKey, request:entry.request, action:actions[operationKey] }))));
    commands = next;
  }
  async function load() {
    const epoch = ++readEpoch, session = sessionEpoch;
    readController?.abort(); readController = new AbortController();
    const signal = readController.signal;
    for (const key of Object.keys(sources)) states[key] = 'loading';
    render();
    const current = () => !disposed && epoch === readEpoch && session === sessionEpoch && !signal.aborted;
    try {
      const client = await readWithDeadline(() => getClient(), { signal });
      if (!current()) return;
      const read = async (operation, validate) => {
        try {
          const value = await readWithDeadline(operation, { signal });
          if (!validate(value)) throw new Error('Invalid source contract');
          return value;
        } catch (error) { if (current() && authorizationFailure(error)) invalidate(); throw error; }
      };
      const results = await Promise.allSettled([
        read(signal => client.getBoard({ signal }), value => scopedDeals(value, 'team') !== null && value.deals.every(row => typeof row.name === 'string' && PHASES.includes(row.phase))),
        read(signal => client.getInvoiceTracker({ signal }), validInvoiceTracker),
        read(signal => planner.library({ signal }), value => Boolean(validateTourList(value))),
      ]);
      if (!current()) return;
      const actors = results.slice(0,2).filter(r => r.status === 'fulfilled').map(r => r.value.actor).filter(Boolean);
      if (new Set(actors).size > 1) { invalidate('Session changed. Open Doc to continue.'); return; }
      if (!retainScope(client, actors[0])) return;
      for (const [index,key] of ['deals','invoices','tours'].entries()) {
        const result = results[index];
        states[key] = result.status === 'fulfilled' ? 'ready' : 'unavailable';
        sources[key] = result.status === 'fulfilled' ? index === 0 ? result.value.deals : index === 1 ? result.value.entries : result.value : [];
      }
      // A newly observed base cannot authorize an old approval. An unknown
      // request remains eligible only for replaying that original request.
      if (pending && !pending.href && !commands[operationFor(pending.action)]) {
        const fresh = commandResults({ text:input.value, ...sources, today:localToday() }).find(row => row.id === pending.id);
        if (!fresh?.action || JSON.stringify(fresh.action) !== JSON.stringify(pending.action)) { unstage(); notice = 'Record changed. Review the current result.'; }
      }
    } catch (error) {
      if (!current()) return;
      if (authorizationFailure(error)) { invalidate(); return; }
      for (const key of Object.keys(sources)) { sources[key] = []; states[key] = 'unavailable'; }
    }
    if (current()) render();
  }
  function findParties(query) {
    const epoch = ++findEpoch, session = sessionEpoch;
    win.clearTimeout(findTimer); findController?.abort(); parties = null; partyQuery = ''; states.find = query.length >= 2 ? 'loading' : 'empty';
    if (query.length < 2) return;
    findController = new AbortController(); const signal = findController.signal;
    const current = () => !disposed && epoch === findEpoch && session === sessionEpoch && !signal.aborted;
    findTimer = win.setTimeout(async () => {
      try {
        const payload = await readWithDeadline(async signal => (await getClient()).find({ query }), { signal });
        if (!current()) return;
        if (!validSearchPayload(payload)) throw new Error('Invalid search contract');
        parties = payload; partyQuery = query; states.find = 'ready';
      } catch (error) {
        if (!current()) return;
        if (authorizationFailure(error)) { invalidate(); return; }
        states.find = 'unavailable';
      }
      if (current()) render();
    }, 180);
  }
  function render() {
    if (disposed) return;
    const text = input.value, intent = interpretCommand(text);
    rows = states.deals === 'refused' ? [] : commandResults({ text, pages,
      deals:states.deals === 'ready' ? sources.deals : [], invoices:states.invoices === 'ready' ? sources.invoices : [], tours:states.tours === 'ready' ? sources.tours : [],
      parties:partyQuery === intent.query ? parties : null, today:localToday() });
    // Ambiguity precedes eligibility. A changed candidate set always discards
    // selection, even when one candidate is already at the requested phase.
    for (const [key,entry] of Object.entries(commands)) {
      const action = actions[key];
      if (!action || entry.status === 'pending') continue;
      const id = action.verb === 'move' ? `move:${action.deal}` : `paid:${action.commission_id}`;
      const index = rows.findIndex(row => row.id === id);
      const sameTarget = intent.type === action.verb && (action.verb !== 'move' || intent.phase === action.to);
      if (index >= 0 && sameTarget) rows[index] = { ...rows[index], href:undefined, action, detail:'Confirmation pending · Check outcome' };
      else if (!text.trim() || sameTarget && action.name.toLowerCase().includes(intent.target?.toLowerCase())) rows.push({ id,kind:'action',label:`Check outcome · ${action.name}`, detail:'Confirmation pending',action });
    }
    const nextIdentities = JSON.stringify(rows.map(row => row.id));
    if (identities !== nextIdentities) active = -1;
    identities = nextIdentities;
    if (active >= rows.length) active = -1;
    if (active === -1 && rows.length === 1) active = 0;
    dialog.classList.toggle('doc-commanding', Boolean(text.trim() || pending || rows.length));
    list.hidden = Boolean(pending) || rows.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    list.innerHTML = rows.map((row,index) => {
      const [glyph,kind] = KIND[row.kind === 'action' ? row.action?.verb || 'plan' : row.kind];
      const detail = row.action?.verb === 'paid' && typeof row.detail !== 'string' ? money(row.detail) : row.detail;
      return `<li role="option" id="docResult${index}" data-doc-result="${index}" aria-selected="${!pending && index === active}" class="doc-result${row.action?.approval === 'one-tap' ? ' doc-result-staged' : ''}"><span class="doc-result-glyph" aria-hidden="true">${glyph}</span><span class="doc-result-text"><b>${escape(row.label)}</b>${detail != null ? `<span>${escape(detail)}</span>` : ''}</span><span class="doc-result-kind">${kind}</span></li>`;
    }).join('');
    if (!list.hidden && active >= 0) input.setAttribute('aria-activedescendant',`docResult${active}`); else input.removeAttribute('aria-activedescendant');
    const relevant = intent.type === 'move' ? [states.deals] : intent.type === 'paid' ? [states.invoices] : Object.values(states).filter(state => state !== 'empty');
    const failed = relevant.filter(state => state === 'unavailable').length, loading = relevant.includes('loading');
    const message = notice || (loading ? 'Loading…' : failed ? relevant.every(state => state === 'unavailable') ? 'Results unavailable.' : 'Partial results. Some sources are unavailable.' : text.trim() && !rows.length ? 'No matches.' : '');
    status.innerHTML = `${escape(message)}${failed && !busy ? ' <button type="button" data-doc-retry>Retry</button>' : ''}`;
  }
  function stage(row) {
    ++interaction; pending = row; notice = '';
    const action = row.action, detail = action.verb === 'paid' ? `${money(action.amount)} · received ${day(action.received_on)}` : `${phaseLabel(action.from)} → ${phaseLabel(action.to)}`;
    staged.innerHTML = `<span class="doc-spark" aria-hidden="true">✦</span><div><h3>${escape(row.label)}</h3><p>${escape(detail)}</p></div><button type="button" id="docStagedApprove">${row.href ? 'Review closing' : commands[operationFor(action)] ? 'Check outcome' : 'Mark paid'}</button><button type="button" id="docStagedCancel" aria-label="Cancel">×</button>`;
    staged.hidden = false; render(); $('docStagedApprove').focus();
  }
  async function execute(row) {
    if (busy || disposed || states.deals === 'refused') return;
    if (row.href) { navigate(row.href); return; }
    const action = row.action, key = operationFor(action), origin = interaction, session = sessionEpoch;
    busy = true; notice = 'Working…'; dialog.classList.add('doc-busy'); render();
    if (pending === row) for (const button of staged.querySelectorAll('button')) button.disabled = true;
    try {
      const client = await readWithDeadline(() => getClient(), { timeoutMs:writeTimeoutMs });
      if (disposed || session !== sessionEpoch) return;
      actions[key] ||= action;
      const retained = commands[key];
      const sameIntent = retained && (action.verb === 'paid' || retained.request.value === action.to);
      const result = await performCommand({ operationKey:key, args:sameIntent ? retained.request : argsFor(action),
        getState:()=>commands, setState:next=>{ if (session === sessionEpoch) saveCommands(next); }, newKey:uuid,
        call:request=>readWithDeadline(async () => {
          const response = await (action.verb === 'move' ? client.patchDealField(request) : client.markInvoicePaid(request));
          if (response?.ok === false && typeof response.error === 'string') throw Object.assign(new Error('Command refused'), { payload:response });
          return response;
        }, { timeoutMs:writeTimeoutMs }),
      });
      if (disposed || session !== sessionEpoch) return;
      if (result.reason === 'unauthorized' || result.code === 'authentication_required' || [401,403].includes(result.http_status)) { invalidate(); return; }
      if (origin === interaction) {
        notice = result.status === 'ok' ? action.verb === 'move' ? `${action.name} moved to ${phaseLabel(action.to)}` : `${action.name} marked paid`
          : result.status === 'conflict' ? 'Record changed. Review the current version.'
          : result.status === 'refused' ? result.message : `${action.name} unconfirmed. Check outcome before another change.`;
        if (['ok','refused','conflict'].includes(result.status)) { unstage(); if (result.status === 'ok') input.value = ''; input.focus(); }
        else if (pending === row) $('docStagedApprove').textContent = 'Check outcome';
      }
      if (!commands[key]) delete actions[key];
      if (result.status === 'ok') afterWrite();
    } catch (error) {
      if (disposed || session !== sessionEpoch) return;
      if (authorizationFailure(error)) { invalidate(); return; }
      if (origin === interaction) notice = 'Command unavailable. Recovery could not be retained.';
    } finally {
      busy = false;
      if (!disposed) {
        dialog.classList.remove('doc-busy');
        for (const button of staged.querySelectorAll('button')) button.disabled = false;
        render(); if (session === sessionEpoch) void load();
      }
    }
  }
  function activate(index) {
    if (pending || states.deals === 'refused') return;
    const row = rows[index]; if (!row) return;
    if (row.action?.approval === 'one-tap') stage(row);
    else if (row.href) navigate(row.href);
    else if (row.action) void execute(row);
  }
  on(input,'input',() => {
    ++interaction; unstage(); notice = ''; active = -1;
    const intent = interpretCommand(input.value); findParties(intent.type === 'search' ? intent.query : ''); render();
  });
  on(input,'keydown',event => {
    if (event.isComposing || pending) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (!rows.length) return;
      active = event.key === 'ArrowDown' ? (active + 1) % rows.length : (active <= 0 ? rows.length : active) - 1; render();
    } else if (event.key === 'Enter') { event.preventDefault(); if (active >= 0) activate(active); }
  });
  function cancel(event) {
    if (!input.value && !pending) return;
    event.preventDefault(); ++interaction; input.value = ''; unstage(); notice = ''; findParties(''); render(); input.focus();
  }
  on(dialog,'keydown',event => { if (event.key === 'Escape' && !event.isComposing) cancel(event); });
  on(dialog,'cancel',cancel);
  on(list,'mousemove',event => { const item = event.target.closest('[data-doc-result]'); if (!pending && item && Number(item.dataset.docResult) !== active) { active = Number(item.dataset.docResult); render(); } });
  on(list,'click',event => { const item = event.target.closest('[data-doc-result]'); if (item) activate(Number(item.dataset.docResult)); });
  on(staged,'click',event => {
    if (event.target.closest('#docStagedApprove') && pending) void execute(pending);
    if (event.target.closest('#docStagedCancel')) { ++interaction; unstage(); render(); input.focus(); }
  });
  on(status,'click',event => { if (event.target.closest('[data-doc-retry]')) { notice = ''; void load(); const intent = interpretCommand(input.value); findParties(intent.type === 'search' ? intent.query : ''); render(); } });
  on($('docCommand'),'submit',event => event.preventDefault());
  return {
    focus() { input.focus(); input.select(); void load(); }, invalidate,
    dispose() { disposed = true; ++readEpoch; ++findEpoch; readController?.abort(); findController?.abort(); win.clearTimeout(findTimer); listeners.forEach(remove=>remove()); },
  };
}
