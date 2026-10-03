import { commandResults, interpretCommand } from './doc-command-model.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { localToday } from './calendar-model.js';
import { phaseLabel } from './client.js';
import { createPlannerClient } from '../tours/planner-client.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const KIND = { page:['▤','Page'], deal:['▦','Deal'], lead:['◎','Lead'], client:['◉','Client'], vendor:['♧','Vendor'], party:['◌','Person'], tour:['◇','Tour'], move:['✦','Move'], paid:['✦','Payment'], plan:['✦','Tour plan'] };
const day = value => new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
const money = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '';
const APPROVE = { move:'Close deal', paid:'Mark paid' };

// The command half of Doc: one input that searches what Doc can read and
// turns plain words into an exact, typed result. Opening is immediate; an
// internal reversible move runs on its own row; money and closing a deal stage
// a card that waits for one tap. Each staged action keeps one idempotency key.
export function mountDocCommand({ dialog, getClient, pages = [], uuid, navigate, afterWrite, planner = createPlannerClient() }) {
  const $ = id => dialog.querySelector(`#${id}`);
  const input = $('docAsk'), list = $('docResults'), staged = $('docStaged'), status = $('docCommandStatus');
  let sources = { deals: [], invoices: [], tours: [] }, parties = null, partyQuery = '', rows = [], active = -1, pending = null, busy = false, findTimer = 0, findEpoch = 0;
  const intents = new Map();

  async function load() {
    const client = await getClient();
    const [board, invoices, tours] = await Promise.allSettled([
      readWithDeadline(() => client.getBoard()), readWithDeadline(() => client.getInvoiceTracker()), planner.library(),
    ]);
    sources = {
      deals: board.status === 'fulfilled' && Array.isArray(board.value?.deals) ? board.value.deals : sources.deals,
      invoices: invoices.status === 'fulfilled' && Array.isArray(invoices.value?.entries) ? invoices.value.entries : sources.invoices,
      tours: tours.status === 'fulfilled' ? tours.value : sources.tours,
    };
    render();
  }
  function findParties(query) {
    const epoch = ++findEpoch; globalThis.clearTimeout(findTimer);
    if (query.length < 2) { parties = null; partyQuery = ''; return; }
    findTimer = globalThis.setTimeout(async () => {
      try {
        const payload = await readWithDeadline(async () => (await getClient()).find({ query }));
        if (epoch === findEpoch) { parties = payload; partyQuery = query; render(); }
      } catch { if (epoch === findEpoch) { parties = null; render(); } }
    }, 180);
  }
  function render() {
    const text = input.value;
    rows = commandResults({ text, pages, ...sources, parties: partyQuery && interpretCommand(text).query === partyQuery ? parties : null, today: localToday() });
    // Several write candidates are a question, not a choice: nothing is preselected.
    if (active >= rows.length) active = -1;
    if (active === -1 && rows.length && rows.filter(row => row.action).length <= 1) active = 0;
    dialog.classList.toggle('doc-commanding', text.trim() !== '');
    list.hidden = rows.length === 0;
    input.setAttribute('aria-expanded', String(rows.length > 0));
    list.innerHTML = rows.map((row, index) => {
      const [glyph, kind] = KIND[row.kind === 'action' ? row.action?.verb || 'plan' : row.kind];
      const detail = row.action?.verb === 'paid' ? money(row.detail) : row.detail;
      return `<li role="option" id="docResult${index}" data-doc-result="${index}" aria-selected="${index === active}" class="doc-result${row.action?.approval === 'one-tap' ? ' doc-result-staged' : ''}"><span class="doc-result-glyph" aria-hidden="true">${glyph}</span><span class="doc-result-text"><b>${escape(row.label)}</b>${detail ? `<span>${escape(detail)}</span>` : ''}</span><span class="doc-result-kind">${kind}</span></li>`;
    }).join('');
    if (active >= 0) input.setAttribute('aria-activedescendant', `docResult${active}`); else input.removeAttribute('aria-activedescendant');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }
  function stage(row) {
    pending = row; status.textContent = '';
    const action = row.action, detail = action.verb === 'paid' ? `${money(action.amount)} · received ${day(action.received_on)}` : `${phaseLabel(action.from)} → ${phaseLabel(action.to)}`;
    staged.innerHTML = `<span class="doc-spark" aria-hidden="true">✦</span><div><h3>${escape(row.label)}</h3><p>${escape(detail)}</p></div><button type="button" id="docStagedApprove">${APPROVE[action.verb]}</button><button type="button" id="docStagedCancel" aria-label="Cancel">×</button>`;
    list.hidden = true; staged.hidden = false; $('docStagedApprove').focus();
  }
  function unstage() { pending = null; staged.hidden = true; staged.replaceChildren(); list.hidden = rows.length === 0; }
  async function execute(row) {
    if (busy) return;
    const action = row.action, signature = JSON.stringify(action);
    const intent = intents.get(signature) || { key: uuid() }; intents.set(signature, intent);
    busy = true; dialog.classList.add('doc-busy'); status.textContent = 'Working…';
    for (const button of staged.querySelectorAll('button')) button.disabled = true;
    try {
      const client = await getClient();
      if (action.verb === 'move') {
        const result = await client.patchDealField({ deal: action.deal, field: 'phase', value: action.to, base_event_id: action.base_event_id, idempotency_key: intent.key });
        status.textContent = result?.status === 'ok' ? `${action.name} moved to ${phaseLabel(action.to)}` : `${action.name} changed`;
      } else {
        const result = await client.markInvoicePaid({ commission_id: action.commission_id, base_version: action.base_version, received_on: action.received_on, idempotency_key: intent.key });
        status.textContent = result?.ok === true ? `${action.name} marked paid` : `${action.name} unconfirmed`;
      }
      intents.delete(signature); unstage(); input.value = ''; render(); afterWrite();
    } catch (error) {
      const code = error?.payload?.error;
      // A decided refusal releases the key; an unknown outcome keeps it so a
      // second tap is the same write, never a second one.
      if (['version_conflict', 'invoice_not_unpaid', 'invoice_not_found'].includes(code)) { intents.delete(signature); unstage(); status.textContent = `${action.name} changed`; }
      else status.textContent = `${action.name} unconfirmed`;
    } finally {
      busy = false; dialog.classList.remove('doc-busy');
      for (const button of staged.querySelectorAll('button')) button.disabled = false;
      void load();
    }
  }
  function activate(index) {
    const row = rows[index]; if (!row) return;
    if (row.href) return navigate(row.href);
    if (row.action.approval === 'one-tap') return stage(row);
    void execute(row);
  }

  input.addEventListener('input', () => {
    unstage(); status.textContent = ''; active = -1;
    const intent = interpretCommand(input.value);
    findParties(intent.type === 'search' ? intent.query : '');
    render();
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (!rows.length) return;
      active = event.key === 'ArrowDown' ? (active + 1) % rows.length : (active <= 0 ? rows.length : active) - 1; render();
    } else if (event.key === 'Enter') {
      event.preventDefault(); if (active >= 0) activate(active);
    } else if (event.key === 'Escape' && (input.value || pending)) {
      event.preventDefault(); input.value = ''; unstage(); status.textContent = ''; findParties(''); render();
    }
  });
  list.addEventListener('mousemove', event => { const item = event.target.closest('[data-doc-result]'); if (item && Number(item.dataset.docResult) !== active) { active = Number(item.dataset.docResult); render(); } });
  list.addEventListener('click', event => { const item = event.target.closest('[data-doc-result]'); if (item) activate(Number(item.dataset.docResult)); });
  staged.addEventListener('click', event => {
    if (event.target.closest('#docStagedApprove') && pending) void execute(pending);
    if (event.target.closest('#docStagedCancel')) { unstage(); render(); input.focus(); }
  });
  $('docCommand').addEventListener('submit', event => event.preventDefault());

  return {
    focus() { input.focus(); input.select(); void load(); },
    dispose() { globalThis.clearTimeout(findTimer); ++findEpoch; },
  };
}
