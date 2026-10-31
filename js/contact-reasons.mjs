import { homeListLimit, createContactReasonsView } from './ui.generated.js';
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
function validate(payload) {
  if (payload?.ok !== true || payload.contract !== 'practice-origination.v1' || payload.outreach_started !== false
    || !Array.isArray(payload.cards) || !Array.isArray(payload.coverage)
    || !(payload.next_cursor === null || /^[1-9][0-9]{0,18}$/.test(payload.next_cursor))
    || !payload.coverage.every(row => row && sources[row.source] && ['available','blocked','unavailable','uncovered'].includes(row.status))) {
    throw new Error('Contact reasons unavailable');
  }
  return {...payload, cards: payload.cards.filter(row => row && /^[1-9][0-9]{0,18}$/.test(row.id) && typeof row.name === 'string'
      && kinds[row.kind] && ['research','relationship_follow_up','identity_review'].includes(row.route)
      && /^\d{4}-\d{2}-\d{2}$/.test(row.evidence_date) && Number.isFinite(Date.parse(row.evidence_date))
      && typeof row.city === 'string' && typeof row.state === 'string'
      && Array.isArray(row.client_ids) && Array.isArray(row.client_refs)
      && row.client_ids.every(id => typeof id === 'string' && id.length) && row.client_refs.every(ref => typeof ref === 'string')
      && (row.route !== 'relationship_follow_up' || row.client_ids.length === 1)
      && publicSource(row))};
}
function publicSource(row) {
  try {
    const url = new URL(row.source_url);
    return url.protocol === 'https:' && !url.username && !url.password && (row.source === 'nppes'
      ? url.hostname === 'npiregistry.cms.hhs.gov' && url.pathname === `/provider-view/${row.npi}`
      : row.source === 'pecos' && url.hostname === 'data.cms.gov');
  } catch { return false; }
}
export function mountContactReasons({host,window,client,home = false}) {
  const document = host.ownerDocument;
  let payload = null, error = false, busy = false, retired = false, sequence = 0, visibleCount = homeListLimit(window);
  const view = createContactReasonsView(host);
  function render() {
    host.hidden = Boolean(home && payload && !error && !retired && !payload.cards.some(row => row.route === 'research'));
    host.setAttribute('aria-busy',String(busy));
    view.render({payload,error,busy,retired,home,visibleCount});
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
    if (event.target.closest('[data-show-reasons]')) { visibleCount = Infinity; render(); }
    if (event.target.closest('[data-retry-reasons]')) auto.refresh();
    if (event.target.closest('[data-more-reasons]')) read({},true);
  };
  host.addEventListener('click',click);
  window.addEventListener('doctorcre-session-invalidated',retire);
  render();
  auto.refresh();
  return {refresh:()=>auto.refresh(),dispose(){retired = true; sequence++; auto.dispose(); view.dispose(); host.removeEventListener('click',click); window.removeEventListener('doctorcre-session-invalidated',retire);}};
}
