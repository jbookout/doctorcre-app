import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { pageDocContext } from './doc-context.js';
import { contextualSuggestions, docAnswer, DOC_PAGES } from './doc-context-model.js';
import { DOC_EVALUATED_PAGES } from './doc-accuracy.js';
import { createDocApproval } from './doc-approval.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { entryDetailsHtml } from './entry-details.mjs';
import { uuidv4 } from './uuid.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const display = value => value === null ? 'Unknown' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);

export function mountDocPresence({ document: root = document, window: win = window, context = pageDocContext, client: supplied, intervalMs = 30_000 } = {}) {
  const main = root.getElementById('appMainSlot');
  if (!main || !context || root.getElementById('docPresence')) return null;
  const style = root.createElement('link'); style.rel = 'stylesheet'; style.href = '/css/doc-presence.css'; root.head.append(style);
  const strip = root.createElement('section'); strip.id = 'docPresence'; strip.className = 'doc-presence'; strip.setAttribute('aria-label', 'Doc');
  strip.innerHTML = '<button id="docOpen" class="doc-identity" type="button" aria-haspopup="dialog" aria-controls="docDetail"><span class="doc-orb" aria-hidden="true">◍</span><span><b>Doc</b><span id="docPageLabel"></span></span><span aria-hidden="true">↗</span></button><div id="docSuggestions" class="doc-suggestion-strip" aria-live="polite"></div><div class="doc-updated"><time id="docUpdated">Updating…</time><button id="docRefresh" type="button" aria-label="Refresh Doc" title="Refresh Doc">↻</button></div>';
  main.prepend(strip);
  const dialog = root.createElement('dialog'); dialog.id = 'docDetail'; dialog.className = 'doc-detail'; dialog.setAttribute('aria-labelledby','docTitle');
  dialog.innerHTML = '<header><div><span class="doc-orb" aria-hidden="true">◍</span><h2 id="docTitle">Doc</h2></div><button id="docClose" type="button" aria-label="Close Doc">×</button></header><div class="doc-detail-grid"><section><label for="docRecord">Record<select id="docRecord"></select></label><div id="docFacts"></div><div id="docActivity"></div></section><section><h3>Suggestions</h3><div id="docActionList"></div><p id="docApprovalStatus" role="status"></p><a href="/doc-chats" class="doc-chats-link">Doc Chats ↗</a><a href="/doc-activity" class="doc-chats-link" data-doc-activity-link>Doc Activity ↗</a></section></div>';
  root.body.append(dialog);
  const $ = id => root.getElementById(id);
  let snapshot = context.snapshot(), suggestions = null, suggestionState = 'updating', client = supplied, approval, shown = [], chosen = null, disposed = false, readEpoch = 0, lastScope = '';
  const keep = (target, html) => {
    if (target.innerHTML === html) return;
    const focus = target.contains(root.activeElement) ? root.activeElement?.dataset.docKey : null;
    const expanded = [...target.querySelectorAll('details[open]')].map(node => node.dataset.entry);
    target.innerHTML = html;
    for (const node of target.querySelectorAll('details')) if (expanded.includes(node.dataset.entry)) node.open = true;
    if (focus) ([...target.querySelectorAll('[data-doc-key]')].find(node => node.dataset.docKey === focus) || $('docClose')).focus();
  };
  // Keep the same presence reachable in a native record popup. DOM state
  // controls placement only; record identity still comes from the page read.
  function placePresence() {
    const hosts = [...root.querySelectorAll('dialog[open]:not(#docDetail), aside#recordPanel:not([hidden])')];
    const host = hosts.at(-1) || main;
    strip.classList.toggle('doc-in-detail', host !== main);
    if (strip.parentElement !== host) host.prepend(strip);
  }
  const render = () => {
    placePresence();
    $('docPageLabel').textContent = snapshot.active?.title || snapshot.label;
    strip.dataset.state = snapshot.state;
    $('docUpdated').textContent = updatedLabel(snapshot.observedAt);
    if (snapshot.observedAt) $('docUpdated').dateTime = snapshot.observedAt; else $('docUpdated').removeAttribute('datetime');
    shown = contextualSuggestions(snapshot, suggestions, { evaluatedPages: DOC_EVALUATED_PAGES });
    const state = !snapshot.ready ? snapshot.state === 'updating' ? 'Updating…' : 'Unavailable' : suggestionState === 'unavailable' ? 'Suggestions unavailable' : suggestionState === 'updating' ? 'Updating…' : 'No suggestions';
    keep($('docSuggestions'), shown.length ? shown.slice(0, 2).map(row => `<button type="button" data-doc-suggestion="${escape(row.id)}" data-doc-key="suggestion:${escape(row.id)}"><span aria-hidden="true">✦</span>${escape(row.polished_text || 'Review suggestion')}<span aria-hidden="true">↗</span></button>`).join('') : `<span class="doc-quiet">${state}</span>`);
    if (!dialog.open) return;
    const records = snapshot.ready ? snapshot.records : [];
    const selected = snapshot.active ? `${snapshot.active.kind}:${snapshot.active.id}` : chosen;
    const selectedRecord = records.find(row => `${row.kind}:${row.id}` === selected);
    // Keep exact selection; a vanished card never silently becomes another one.
    keep($('docRecord'), '<option value="">Record</option>' + records.map(row => `<option value="${escape(`${row.kind}:${row.id}`)}">${escape(row.title)}</option>`).join(''));
    $('docRecord').value = selectedRecord ? selected : ''; $('docRecord').disabled = !!snapshot.selected || !snapshot.ready;
    const facts = selectedRecord ? `<h3>${escape(selectedRecord.title)}</h3><dl>${selectedRecord.fields.map(item => { const answer = docAnswer(snapshot, { kind:selectedRecord.kind, recordId:selectedRecord.id, question:item.label }); return `<div><dt>${escape(item.label)}</dt><dd>${escape(display(answer.value))}</dd></div>`; }).join('')}</dl>` : snapshot.ready ? '' : `<p class="doc-quiet">${state}</p>`;
    keep($('docFacts'), facts);
    keep($('docActivity'), selectedRecord?.activityComplete === false
      ? '<p class="doc-quiet">Recent activity unknown: conversation read is incomplete.</p>'
      : selectedRecord?.activity.length ? '<h3>Recent activity</h3>' + selectedRecord.activity.slice(0, 5).map((item,i) => `<article class="doc-activity">${entryDetailsHtml(item.text).replace('<details>', `<details data-entry="${escape(selectedRecord.id)}:${i}">`)}</article>`).join('') : '');
    keep($('docActionList'), shown.length ? shown.map(row => `<article class="doc-action" data-doc-action="${escape(row.id)}"><span class="doc-spark" aria-hidden="true">✦</span><h4>${escape(row.polished_text || 'Review suggestion')}</h4>${row.uncertainty ? `<p>${escape(row.uncertainty)}</p>` : ''}<details data-entry="suggestion:${escape(row.id)}"><summary>Details</summary><p class="entry-original">${escape(row.original_text || '')}</p></details><button type="button" data-doc-approve="${escape(row.id)}" data-doc-key="approve:${escape(row.id)}" ${approval?.busy ? 'disabled' : ''}>Approve discussion</button></article>`).join('') : `<span class="doc-quiet">${state}</span>`);
  };
  const refresh = async ({ signal } = {}) => {
    const epoch = ++readEpoch, captured = context.snapshot();
    const scope = `${captured.epoch}:${captured.page}:${captured.selected?.kind || ''}:${captured.selected?.id || ''}`;
    suggestionState = 'updating'; suggestions = null; render();
    try {
      client ||= await createClient(resolveDealroomBoot(win.location).mode, { ...resolveDealroomBoot(win.location).options, docContext:false });
      approval ||= createDocApproval({ client, context, evaluatedPages:DOC_EVALUATED_PAGES, uuid:uuidv4 });
      const args = captured.page === 'chats' && captured.selected?.kind === 'conversation' ? { conversation_id:captured.selected.id } : {};
      const payload = await readWithDeadline(() => client.listDocSuggestions(args), { signal });
      const current = context.snapshot();
      if (disposed || signal?.aborted || epoch !== readEpoch || scope !== `${current.epoch}:${current.page}:${current.selected?.kind || ''}:${current.selected?.id || ''}`) return;
      if (payload?.ok !== true || !Array.isArray(payload.suggestions)) throw new Error('Unavailable');
      suggestions = payload; suggestionState = 'ready'; approval.reconcile(payload);
    } catch (error) { if ([401,403].includes(error.status)) context.clear(); if (epoch === readEpoch) { suggestions = null; suggestionState = 'unavailable'; } }
    finally { if (epoch === readEpoch && !disposed) render(); }
  };
  const auto = mountAutoRefresh({ document:root, window:win, refresh, intervalMs });
  const open = () => { if (!dialog.open) dialog.showModal(); render(); };
  $('docOpen').onclick = open;
  $('docClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => $('docOpen').focus());
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('[data-doc-approve]'); if (!button || !approval || approval.busy || DOC_PAGES[snapshot.page].approvals === false) return;
    const row = shown.find(item => item.id === button.dataset.docApprove); if (!row) return;
    button.disabled = true; $('docApprovalStatus').textContent = 'Confirming…';
    const originScope=lastScope, originRecord=chosen;
    const result = await approval.approve(row, suggestions);
    if (disposed || originScope !== lastScope || originRecord !== chosen) return;
    $('docApprovalStatus').textContent = result.state === 'approved' ? 'Discussion approved' : result.state === 'changed' ? 'Suggestion changed' : 'Confirmation unavailable';
    await auto.refresh(); render();
  });
  $('docSuggestions').addEventListener('click', event => { if (event.target.closest('[data-doc-suggestion]')) open(); });
  $('docRecord').onchange = () => { chosen = $('docRecord').value || null; render(); };
  $('docRefresh').onclick = () => { context.tick(); auto.refresh(); root.querySelectorAll('[data-layout-refresh]').forEach(button => button.click()); };
  const unsubscribe = context.subscribe(next => {
    const previous = snapshot; snapshot = next;
    const scope = `${next.epoch}:${next.page}:${next.selected?.kind || ''}:${next.selected?.id || ''}`;
    const changed = lastScope && scope !== lastScope;
    if (changed) { ++readEpoch; suggestions = null; suggestionState = 'updating'; chosen = null; $('docApprovalStatus').textContent = ''; }
    if ((changed && (next.ready || next.selected)) || (!previous.ready && next.ready)) win.queueMicrotask(async () => { await auto.refresh(); if (suggestionState === 'updating' && !disposed) auto.refresh(); });
    lastScope = scope; render();
  });
  const placement = new win.MutationObserver(placePresence);
  placement.observe(root.body, { subtree:true, childList:true, attributes:true, attributeFilter:['open','hidden'] });
  placePresence();
  const tick = globalThis.setInterval(() => context.tick(), 1_000); tick?.unref?.();
  root.addEventListener('doctorcre:open-doc', open);
  auto.refresh();
  const dispose = () => { disposed = true; ++readEpoch; auto.dispose(); placement.disconnect(); unsubscribe(); globalThis.clearInterval(tick); root.removeEventListener('doctorcre:open-doc',open); };
  win.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
  return { open, refresh:auto.refresh, dispose };
}
