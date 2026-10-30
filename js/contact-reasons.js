import { workCard } from './work-card.js';
import { escapeText as E } from './change-receipts.mjs';
import { mountAutoRefresh, readWithDeadline } from './auto-refresh.mjs';

const kinds = {
  enumeration: ['Practice registered in NPPES', 'Registration date'],
  registry_update: ['Practice registration updated', 'Registry update date'],
  pecos_observation: ['Medicare enrollment listed', 'Publication date'],
  pecos_correction: ['Medicare enrollment evidence corrected', 'Publication date'],
};
const sources = {
  nppes: 'NPPES', pecos: 'PECOS', 'formation-al': 'Alabama formations', 'formation-fl': 'Florida formations',
  'recorder-escambia-fl': 'Escambia County recorder', 'recorder-baldwin-al': 'Baldwin County recorder',
  'recorder-other': 'Other county recorders',
};
const date = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
function validate(payload) {
  if (payload?.ok !== true || payload.contract !== 'practice-origination.v1' || payload.outreach_started !== false
    || !Array.isArray(payload.cards) || !Array.isArray(payload.coverage)
    || !(payload.next_cursor === null || /^[1-9][0-9]{0,18}$/.test(payload.next_cursor))
    || !payload.cards.every(row => row && /^[1-9][0-9]{0,18}$/.test(row.id) && typeof row.name === 'string'
      && kinds[row.kind] && ['research','relationship_follow_up','identity_review'].includes(row.route)
      && /^\d{4}-\d{2}-\d{2}$/.test(row.evidence_date) && Number.isFinite(Date.parse(row.evidence_date))
      && typeof row.city === 'string' && typeof row.state === 'string'
      && Array.isArray(row.client_ids) && Array.isArray(row.client_refs)
      && row.client_ids.every(id => typeof id === 'string' && id.length) && row.client_refs.every(ref => typeof ref === 'string')
      && (row.route !== 'relationship_follow_up' || row.client_ids.length === 1)
      && publicSource(row))
    || !payload.coverage.every(row => row && sources[row.source] && ['available','blocked','unavailable','uncovered'].includes(row.status))) {
    throw new Error('Contact reasons unavailable');
  }
  return payload;
}
function publicSource(row) {
  try {
    const url = new URL(row.source_url);
    return url.protocol === 'https:' && !url.username && !url.password && (row.source === 'nppes'
      ? url.hostname === 'npiregistry.cms.hhs.gov' && url.pathname === `/provider-view/${row.npi}`
      : row.source === 'pecos' && url.hostname === 'data.cms.gov');
  } catch { return false; }
}
function card(row, home) {
  const [reason, basis] = kinds[row.kind];
  const followUp = row.route === 'relationship_follow_up';
  const title = followUp ? `Follow up with ${row.client_refs[0] || 'client'}` : row.name;
  const href = home ? '/leads#contactReasons' : followUp ? `/clients?record=${encodeURIComponent(row.client_ids[0])}` : null;
  return workCard({title:href ? `<a data-reason-key="title:${E(row.id)}" href="${E(href)}">${E(title)}</a>` : E(title),
    meta:E([row.city,row.state].filter(Boolean).join(' · ')),
    status:row.route === 'identity_review' ? 'Needs review' : '',
    body:`${followUp ? `<p>${E(row.name)}</p>` : ''}<p>${E(reason)}</p><p>${basis} · <time datetime="${E(row.evidence_date)}">${date(row.evidence_date)}</time></p>${row.route === 'identity_review' ? '<p>Confirm which practice this belongs to.</p>' : ''}`,
    actions:`<a data-reason-key="source:${E(row.id)}" href="${E(row.source_url)}" target="_blank" rel="noopener noreferrer">${sources[row.source]} source<span class="sr-only"> for ${E(row.name)} (opens in new tab)</span> ↗</a>`,
  });
}

export function mountContactReasons({host,window,client,home = false}) {
  const document = host.ownerDocument;
  let payload = null, error = false, busy = false, retired = false, sequence = 0;
  function render() {
    host.hidden = false;
    host.setAttribute('aria-busy',String(busy));
    const parts = [`<header class="${home ? 'home-panel-head' : 'section-heading'}"><h2>Reasons to reach out</h2>${home ? '<a class="home-plain-link" data-reason-key="all" href="/leads#contactReasons">All reasons</a>' : ''}</header>`];
    if (retired) {
      parts.push('<p role="status">Sign in to view contact reasons.</p>');
    } else {
      if (error) parts.push(`<p role="status">Contact reasons unavailable.${payload ? ' Showing last update.' : ''} <button type="button" data-reason-key="retry" data-retry-reasons>Try again</button></p>`);
      if (payload) {
        const rows = payload.cards.filter(row => !home || row.route === 'research');
        const shown = home ? rows.slice(0,3) : rows;
        parts.push(`<div class="contact-reason-list">${shown.map(row=>card(row,home)).join('') || '<p>No new reasons to reach out.</p>'}</div>`);
        if (!home) {
          parts.push('<p class="contact-reason-note">Registry and publication dates do not confirm when a practice opened.</p>');
          parts.push(`<ul class="contact-reason-coverage" aria-label="Source coverage">${payload.coverage.map(row=>`<li>${sources[row.source]} · ${row.status === 'available' ? 'Covered' : row.status === 'blocked' ? 'Updates blocked' : 'Not yet covered'}${row.status === 'available' && row.coverage ? ` <small>${E(row.coverage)}</small>` : ''}</li>`).join('')}</ul>`);
          if (payload.next_cursor) parts.push(`<button type="button" data-reason-key="more" data-more-reasons${busy ? ' disabled' : ''}>More reasons</button>`);
        }
      } else if (!error) parts.push('<p role="status">Loading contact reasons…</p>');
    }
    const html = parts.join('');
    if (host.innerHTML === html) return;
    const focused = host.contains(document.activeElement) ? document.activeElement.dataset.reasonKey : null;
    host.innerHTML = html;
    if (focused) [...host.querySelectorAll('[data-reason-key]')].find(node=>node.dataset.reasonKey === focused)?.focus();
  }
  async function read({signal} = {}, more = false) {
    if (retired || busy) return;
    const ticket = ++sequence;
    busy = true; render();
    try {
      const next = validate(await readWithDeadline(signal=>client.listPracticeOrigination({limit:home ? 100 : 25,...(more ? {before_id:payload.next_cursor} : {}),signal}),{signal}));
      if (ticket !== sequence || retired) return;
      payload = more ? {...next,cards:[...payload.cards,...next.cards.filter(row=>!payload.cards.some(old=>old.id===row.id))]} : next;
      error = false;
    } catch (failure) {
      if (ticket !== sequence || retired) return;
      if ([401,403].includes(failure.status) || ['not_authenticated','forbidden'].includes(failure.code)) { retire(); return; }
      error = true;
    } finally {
      if (ticket === sequence && !retired) { busy = false; render(); }
    }
  }
  function clear() { sequence++; busy = false; payload = null; error = false; render(); }
  function retire() { retired = true; clear(); }
  const auto = mountAutoRefresh({document,window,refresh:read,onResume:clear});
  const click = event => {
    if (event.target.closest('[data-retry-reasons]')) auto.refresh();
    if (event.target.closest('[data-more-reasons]')) read({},true);
  };
  host.addEventListener('click',click);
  window.addEventListener('doctorcre-session-invalidated',retire);
  render();
  auto.refresh();
  return {refresh:()=>auto.refresh(),dispose(){retired = true; sequence++; auto.dispose(); host.replaceChildren(); host.removeEventListener('click',click); window.removeEventListener('doctorcre-session-invalidated',retire);}};
}
