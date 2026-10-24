import { escapeText } from './change-receipts.mjs';

const SECTIONS = {
  needs_joe:'Needs Joe', today:'Today and upcoming', claim_card:'Claim card', deals:'Deals and accounts',
  loops:'Open loops', renewals:'Renewals', assurance_cadence:'Assurance cadence', costs:'Costs',
};
const KINDS = { next_action:'Next actions', post_call_action:'Post-call actions', critical_date:'Critical dates including upcoming deadlines', ingest:'Inbox awaiting triage' };
const SOURCES = { loops:'Loops', work_requests:'Work requests', board_questions:'Board questions', governance:'Governance', local:'Local snapshot' };
const STATES = ['ready','empty','partial','unavailable'];
const COLLECTIONS = ['items','accounts','providers'];
const FIELDS = {
  title:'Title', label:'Label', name:'Name', subject_name:'For', subject_ref:'Reference', what:'Action',
  item_kind:'Kind', due_on:'Due', owner_partner:'Partner', owner:'Owner', status:'Status', number:'Number',
  why:'Why', action:'Next action', blocks:'Blocks', since:'Since', age_days:'Age in days', stale:'Stale',
  account_name:'Account', client_name:'Client', phase:'Phase', next_step:'Next step', next_date:'Next date',
  operating_state:'Operating state', blocker_detail:'Blocker', body:'Details',
  display_name:'Name', org_name:'Organization', vertical:'Practice', city:'City', county:'County', state:'State',
  est_lease_event:'Lease event', tier_status:'Tier', flag_status:'Flag', has_channel:'Contact available', decision_count:'Decisions',
  entity_name:'Name', practice_name:'Practice', doctor_name:'Doctor', specialty:'Specialty', score:'Score',
  claimable:'Claimable', needs_contact_count:'Needs contact', window_label:'Window',
  subject:'Subject', message:'Message', summary:'Summary', text:'Text', kind:'Kind', created_at:'Created',
  provider:'Provider', id:'Reference', mtd_usd:'Month to date USD', projection_usd:'Projected USD', budget_usd:'Budget USD',
  reason:'Reason', severity:'Severity', notification_id:'Notification', subject_type:'Subject type',
  pool_id:'Pool reference', base_version:'Version', lane:'Lane', segment:'Segment', segment_play:'Approach', score_basis:'Score basis',
  est_basis:'Lease event basis', days_to_window:'Days to window', needs_contact:'Needs contact', dup_tier:'Duplicate tier', dup_ref:'Duplicate reference', dup_basis:'Duplicate evidence',
  plan:'Plan', estimated:'Estimated', day:'Day', through:'Through', alerts:'Alerts', driver:'Driver',
  amount_usd:'Amount USD', threshold_usd:'Threshold USD', providers:'Providers', drivers:'Drivers',
  observed_at:'Observed', source_observed_at:'Source observed', freshness_state:'Freshness',
  daily:'Daily costs', date:'Date', usd:'USD', months:'Months', month:'Month', total_usd:'Total USD',
};

function rowText(row) {
  if (row === null || row === undefined) return '';
  if (['string','number','boolean'].includes(typeof row)) return String(row);
  if (Array.isArray(row)) return row.map(rowText).filter(Boolean).join('; ');
  return Object.entries(FIELDS).flatMap(([key,label]) => {
    const value = row[key];
    if (value === undefined || value === null) return [];
    const amounts = ['providers','drivers'].includes(key) && !Array.isArray(value) && typeof value === 'object';
    const text = ['why','blocks'].includes(key) && typeof value.text === 'string' ? value.text : amounts ? Object.entries(value)
      .filter(([,amount]) => typeof amount === 'number' && Number.isFinite(amount))
      .map(([name,amount]) => `${name}: ${amount}`).join(', ') : rowText(value);
    return text ? [`${label}: ${text}`] : [];
  }).join('. ');
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
    const metadata = ['costs','claim_card','renewals'].includes(key) ? rowText(state === 'unavailable' ? {action:value?.action} : Object.fromEntries(['observed_at','month','through','budget_usd','projection_usd','months','alerts','action','claimable','needs_contact_count','source_observed_at','freshness_state'].map(key => [key,value?.[key]]))) : '';
    const spoken = [description,...kinds.map(kind => `${kind.label}. ${state === 'unavailable' ? 'count unknown' : `${Number.isInteger(kind.count) ? kind.count : kind.rows.length} returned`}`)].join('. ');
    return { key, label, state, description, spoken, collections, kinds, metadata };
  });
}

export function briefSectionsHtml(sections) {
  const rowsHtml = rows => rows.map(row => {
    const link = row.link || row.deep_link;
    const safeLink = typeof link === 'string' && !/[\\\s]/.test(link) && (/^https:\/\//.test(link) || /^\/(?!\/)/.test(link));
    return `<li>${escapeText(rowText(row))}${safeLink ? ` <a href="${escapeText(link)}">Open record</a>` : ''}</li>`;
  }).join('');
  return `<section class="morning-sections" aria-label="Full brief sections"><p>Coverage counts returned rows only. Priority cards are a selection. Expand each section for all returned records. Owner filters apply to priority cards.</p>${sections.map(section => `<details data-brief-section="${section.key}"><summary>${escapeText(section.description)}</summary>${section.kinds.length ? section.kinds.map(kind => `<section><h4>${escapeText(kind.label)} · ${section.state === 'unavailable' ? 'count unknown' : `${Number.isInteger(kind.count) ? kind.count : kind.rows.length} returned`}</h4><ul>${rowsHtml(kind.rows)}</ul></section>`).join('') : section.collections.filter(collection => section.key !== 'costs' || collection.name !== 'items' || !section.collections.some(value => value.name === 'providers')).map(collection => `<section><h4>${escapeText(collection.name === 'items' ? 'Returned records' : collection.name === 'accounts' ? 'Accounts' : 'Providers')}</h4><ul>${rowsHtml(collection.rows)}</ul></section>`).join('')}${section.metadata ? `<p>${escapeText(section.metadata)}</p>` : ''}</details>`).join('')}</section>`;
}
