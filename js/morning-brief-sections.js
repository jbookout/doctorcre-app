import { escapeText } from './change-receipts.mjs';

const SECTIONS = {
  needs_joe:'Needs Joe', today:'Today and upcoming', claim_card:'Claim card', deals:'Deals and accounts',
  loops:'Open loops', renewals:'Renewals', assurance_cadence:'Assurance cadence', costs:'Costs',
};
const KINDS = { next_action:'Next actions', post_call_action:'Post-call actions', critical_date:'Critical dates including upcoming deadlines', ingest:'Inbox awaiting triage' };
const SOURCES = { loops:'Loops', work_requests:'Work requests', board_questions:'Board questions', governance:'Governance', local:'Local snapshot' };
const STATES = ['ready','empty','partial','unavailable'];
const COLLECTIONS = ['items','accounts','providers'];
const scalar = value => ['string','number','boolean'].includes(typeof value) ? String(value) : '';
const fields = (row, names) => names.flatMap(([key,label]) => {
  const value = scalar(row?.[key]);
  return value ? [`${label}: ${value}`] : [];
}).join('. ');
const context = [['subject_name','For'],['subject_ref','Reference'],['subject_type','Subject type'],['owner_partner','Partner'],['owner','Owner'],['due_on','Due']];
const costs = row => [
  fields(row,[['provider','Provider'],['state','State'],['plan','Plan'],['estimated','Estimated'],['observed_at','Observed'],['month','Month'],['through','Through'],['mtd_usd','Month to date USD'],['projection_usd','Projected USD'],['budget_usd','Budget USD'],['total_usd','Total USD'],['action','Next action']]),
  ...(row.daily || []).map(day => [fields(day,[['day','Day'],['date','Date'],['usd','USD']]),amounts(day.drivers)].filter(Boolean).join('. ')),
  ...(row.months || []).map(month => [fields(month,[['month','Month'],['usd','USD']]),amounts(month.providers)].filter(Boolean).join('. ')),
  ...(row.alerts || []).map(alert => fields(alert,[['provider','Provider'],['driver','Driver'],['kind','Kind'],['amount_usd','Amount USD'],['threshold_usd','Threshold USD']])),
].filter(Boolean).join('. ');
const amounts = values => Object.entries(values || {}).filter(([,amount]) => typeof amount === 'number' && Number.isFinite(amount)).map(([name,amount]) => `${name}: ${amount}`).join(', ');
const accountText = row => fields(row,[['account_name','Account'],['account_client_ref','Reference'],['account_client_id','Account ID'],['account_owner','Owner'],['open_deals','Open deals'],['attention_deals','Attention deals'],['overdue_deals','Overdue deals'],['stale_deals','Stale deals'],['parked_deals','Parked deals']]);
const sectionText = {
  needs_joe: row => [fields(row,[['title','Title'],['action','Next action'],['since','Since'],['age_days','Age in days'],['stale','Stale']]), ...['why','blocks'].map(key => `${key === 'why' ? 'Why' : 'Blocks'}: ${scalar(row[key]?.text) || scalar(row[key])}`).filter(text => !text.endsWith(': '))].filter(Boolean).join('. '),
  today: row => fields(row,[['what','Action'],['id','Reference'],['item_kind','Kind'],...context]),
  claim_card: row => fields(row,[['display_name','Name'],['entity_name','Name'],['practice_name','Practice'],['doctor_name','Doctor'],['org_name','Organization'],['vertical','Practice'],['specialty','Specialty'],['city','City'],['county','County'],['state','State'],['est_lease_event','Lease event'],['tier_status','Tier'],['flag_status','Flag'],['has_channel','Contact available'],['decision_count','Decisions'],['score','Score'],['pool_id','Pool reference'],['base_version','Version'],['lane','Lane'],['segment','Segment'],['segment_play','Approach'],['score_basis','Score basis'],['est_basis','Lease event basis'],['days_to_window','Days to window'],['needs_contact','Needs contact'],['dup_tier','Duplicate tier'],['dup_ref','Duplicate reference'],['dup_basis','Duplicate evidence']]),
  deals: row => fields(row,[['name','Name'],['client_name','Client'],['owner','Owner'],['phase','Phase'],['next_step','Next step'],['next_date','Next date'],['operating_state','Operating state'],['blocker_detail','Blocker']]),
  loops: row => fields(row,[['title','Title'],['label','Label'],['number','Number'],['kind','Kind'],['status','Status'],...context,['blocker_detail','Blocker'],['body','Details']]),
  renewals: row => fields(row,[['display_name','Name'],['org_name','Organization'],['vertical','Practice'],['city','City'],['county','County'],['state','State'],['tier_status','Tier'],['flag_status','Flag'],['has_channel','Contact available'],['decision_count','Decisions'],['source_observed_at','Source observed'],['freshness_state','Freshness'],['name','Name'],['entity_name','Name'],['practice_name','Practice'],['client_name','Client'],['window_label','Window'],['est_lease_event','Lease event'],['next_date','Next date'],['owner','Owner'],['action','Next action']]),
  assurance_cadence: row => fields(row,[['notification_id','Notification'],['reason','Reason'],['severity','Severity'],['title','Title'],['subject_ref','Reference'],['created_at','Created'],['message','Message']]),
  costs,
};
function metadataText(key,value) {
  if (!value) return '';
  if (key === 'costs') return costs(value);
  if (key === 'claim_card' || key === 'renewals') return fields(value,[['action','Next action'],['claimable','Claimable'],['needs_contact_count','Needs contact'],['source_observed_at','Source observed'],['freshness_state','Freshness']]);
  return '';
}

export function briefSections(payload) {
  const entries = payload.coverage?.schema === 'morning-brief-coverage.v1' ? payload.coverage.required_sections : [];
  return Object.entries(SECTIONS).filter(([key]) => key !== 'needs_joe' || payload.sponsor === 'joe').map(([key,label]) => {
    const value = payload.sections[key];
    const entry = Array.isArray(entries) ? entries.find(entry => entry.key === key) : null;
    const state = value && STATES.includes(value.state) ? value.state : 'unavailable';
    const sources = entry?.incomplete_sources || Object.entries(value?.sources || {}).filter(([,source]) => source.state !== 'ready').map(([key,source]) => ({key,state:source.state}));
    const warnings = sources.map(source => `${SOURCES[source.key] || 'Required source'} ${[...STATES,'stale','missing'].includes(source.state) ? source.state : 'unavailable'}`);
    const collections = COLLECTIONS.filter(name => Array.isArray(value?.[name])).map(name => {
      const rows = state === 'unavailable' ? [] : value[name];
      const count = state === 'unavailable' ? 'unknown' : Number.isInteger(entry?.counts?.[name]) ? entry.counts[name] : rows.length;
      return { name, rows, count };
    });
    const counts = state === 'unavailable' ? 'count unknown' : collections.map(({name,count}) => `${count} ${name} returned`).join(', ');
    const description = [label, state, counts, ...warnings].filter(Boolean).join('. ');
    const kinds = key === 'today' ? Object.entries(KINDS).map(([kind,label]) => ({label, count:state === 'unavailable' ? null : value?.item_kinds?.find(entry => entry.kind === kind)?.count, rows:(state === 'unavailable' ? [] : value?.items || []).filter(row => row.item_kind === kind)})) : [];
    if (kinds.length) {
      const other = (state === 'unavailable' ? [] : value?.items || []).filter(row => !KINDS[row.item_kind]);
      if (other.length) kinds.push({label:'Other triage',rows:other});
    }
    const metadata = metadataText(key,state === 'unavailable' ? {action:value?.action} : value);
    return { key, label, state, description, collections, kinds, metadata };
  });
}

export function briefSectionsHtml(sections) {
  const rowsHtml = (rows,key,collection = 'items') => rows.map(row => {
    const text = collection === 'accounts' ? accountText(row) : sectionText[key](row);
    const link = row.link || row.deep_link;
    const safeLink = typeof link === 'string' && !/[\\\s]/.test(link) && (/^https:\/\//.test(link) || /^\/(?!\/)/.test(link));
    const inline = collection === 'accounts' && row.account_client_id ? 'account' : key === 'today' && KINDS[row.item_kind] && row.id ? ({next_action:'next action',post_call_action:'post-call action',critical_date:'critical date',ingest:'inbox item'})[row.item_kind] : null;
    const identity = key === 'today' ? fields(row,[['id','Reference'],['subject_id','Subject ID'],...context]) : accountText({...row,account_name:undefined});
    return `<li>${inline && !safeLink ? `<details><summary>Open ${inline} · ${escapeText(collection === 'accounts' ? row.account_name : row.what)}</summary><p>${escapeText(identity)}</p></details>` : `${escapeText(text)}${safeLink ? ` <a href="${escapeText(link)}">Open record</a>` : ''}`}</li>`;
  }).join('');
  return `<section class="morning-sections" aria-label="Full brief sections"><p>Coverage counts returned rows only. Priority cards are a selection. Expand each section for all returned records. Owner filters apply to priority cards.</p>${sections.map(section => `<details data-brief-section="${section.key}"><summary>${escapeText(section.description)}</summary>${section.kinds.length ? section.kinds.map(kind => `<section><h4>${escapeText(kind.label)} · ${section.state === 'unavailable' ? 'count unknown' : `${Number.isInteger(kind.count) ? kind.count : kind.rows.length} returned`}</h4><ul>${rowsHtml(kind.rows,section.key)}</ul></section>`).join('') : section.collections.filter(collection => section.key !== 'costs' || collection.name !== 'items' || !section.collections.some(value => value.name === 'providers')).map(collection => `<section><h4>${escapeText(collection.name === 'items' ? 'Returned records' : collection.name === 'accounts' ? 'Accounts' : 'Providers')}</h4><ul>${rowsHtml(collection.rows,section.key,collection.name)}</ul></section>`).join('')}${section.metadata ? `<p>${escapeText(section.metadata)}</p>` : ''}</details>`).join('')}</section>`;
}
