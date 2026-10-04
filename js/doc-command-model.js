import { PHASES, PHASE_LABEL, phaseLabel } from './client.js';
import { deepLinkFor, searchAddress } from './search-model.js';

// Doc's command bar, decided without a DOM. A plain-words request becomes a
// typed result against records the page already read; nothing here guesses a
// single target, and nothing here writes.

export function shortcutPlatform(nav = globalThis.navigator) {
  return /mac|iphone|ipad/i.test(nav?.userAgentData?.platform || nav?.platform || '') ? 'mac' : 'other';
}

// Cmd+D / Cmd+K on a Mac, Ctrl+D / Ctrl+K elsewhere. A modifier pressed alone
// never matches, so a held right Command stays with system dictation; on a Mac
// Ctrl+D stays "delete forward" in text fields.
export function docShortcut(event, platform) {
  if (event.isComposing || event.repeat || event.altKey || event.shiftKey) return false;
  const letter = event.code === 'KeyD' || event.code === 'KeyK' || /^[dk]$/i.test(event.key || '');
  if (!letter) return false;
  return platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const PHASE_WORDS = new Map([
  ...PHASES.map(phase => [phase.toLowerCase(), phase]),
  ...Object.entries(PHASE_LABEL).map(([phase, label]) => [label.toLowerCase(), phase]),
  ['loi', 'Negotiation'], ['letter of intent', 'Negotiation'], ['lease', 'Legal'], ['prospect', 'On Deck'],
]);

export function resolvePhase(words) {
  const key = String(words || '').toLowerCase().trim().replace(/^the\s+/, '').replace(/\s+(phase|stage)$/, '');
  return PHASE_WORDS.get(key) || null;
}

export function interpretCommand(text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (!value) return { type: 'empty' };
  const move = value.match(/^(?:move|advance|set|put)\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(.+)$/i);
  if (move && resolvePhase(move[2])) return { type: 'move', target: move[1], phase: resolvePhase(move[2]) };
  const paid = value.match(/^(?:mark|record)\s+(?:the\s+)?(.+?)(?:\s+invoice)?\s+(?:as\s+)?paid$/i);
  if (paid) return { type: 'paid', target: paid[1] };
  const tour = value.match(/^(?:plan|build|schedule|start)\s+(?:a\s+|the\s+)?tour\s+(?:for|with)\s+(.+)$/i);
  if (tour) return { type: 'tour', target: tour[1] };
  return { type: 'search', query: value };
}

const matches = (query, ...fields) => {
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  const words = query.toLowerCase().split(' ').filter(word => word && word !== 'the');
  return words.length > 0 && words.every(word => haystack.includes(word));
};
const dealMatches = (query, deal) => matches(query, deal.name, deal.type, deal.market, deal.segment);
const PARTY_KINDS = new Set(['lead', 'client', 'vendor', 'party']);

// `today` is the local calendar day a payment is recorded for.
export function commandResults({ text, pages = [], deals = [], parties = null, tours = [], invoices = [], today = '' }) {
  const intent = interpretCommand(text);
  if (intent.type === 'move') {
    const targets = deals.filter(deal => dealMatches(intent.target, deal));
    return targets.filter(deal => targets.length > 1 || deal.phase !== intent.phase).map(deal => {
      if (deal.phase === intent.phase) return { id: `move:${deal.id}`, kind: 'deal', label: deal.name,
        detail: `Already ${phaseLabel(intent.phase)}`, href: `/deals?deal=${encodeURIComponent(deal.id)}` };
      return {
        id: `move:${deal.id}`, kind: 'action', label: `Move ${deal.name} to ${phaseLabel(intent.phase)}`,
        detail: `${phaseLabel(deal.phase)} → ${phaseLabel(intent.phase)}`,
        action: { verb: 'move', deal: deal.id, name: deal.name, from: deal.phase, to: intent.phase,
          base_event_id: deal.field_base?.phase?.id ?? null, approval: intent.phase === 'Closed' ? 'one-tap' : 'direct' },
        ...(intent.phase === 'Closed' ? { href: `/deals?deal=${encodeURIComponent(deal.id)}&complete=closed` } : {}),
      };
    });
  }
  if (intent.type === 'paid') {
    return invoices.filter(row => row.status === 'invoiced' && row.commission_id && matches(intent.target, row.name)).map(row => ({
      id: `paid:${row.commission_id}`, kind: 'action', label: `Mark ${row.name} paid`, detail: row.gross_amount,
      action: { verb: 'paid', commission_id: row.commission_id, name: row.name, amount: row.gross_amount,
        base_version: row.base_version, received_on: today, approval: 'one-tap' },
    }));
  }
  if (intent.type === 'tour') {
    return [{ id: 'tour-plan', kind: 'action', label: `Plan a tour for ${intent.target}`, href: `/tours?plan_for=${encodeURIComponent(intent.target)}` }];
  }
  if (intent.type !== 'search') return [];
  const query = intent.query;
  return [
    ...pages.filter(page => matches(query, page.label)).map(page => ({ id: `page:${page.href}`, kind: 'page', label: page.label, href: page.href })),
    ...deals.filter(deal => dealMatches(query, deal)).map(deal => ({ id: `deal:${deal.id}`, kind: 'deal', label: deal.name, detail: phaseLabel(deal.phase), href: `/deals?deal=${encodeURIComponent(deal.id)}` })),
    ...(parties?.deals || []).filter(row => matches(query, row.name) && !deals.some(deal => deal.name === row.name)).map(row => ({
      id: `canonical-deal:${row.name}`, kind: 'deal', label: row.name, detail: phaseLabel(row.phase), href: searchAddress({ query: row.name }) })),
    ...(parties?.parties || []).filter(row => row.merged === false && PARTY_KINDS.has(row.kind) && matches(query, row.name)).map(row => ({
      id: `${row.kind}:${row.name}`, kind: row.kind, label: row.name, href: deepLinkFor(row) || searchAddress({ query: row.name }) })),
    ...tours.filter(tour => matches(query, tour.name)).map(tour => ({ id: `tour:${tour.id}`, kind: 'tour', label: tour.name, href: `/tours?tour=${encodeURIComponent(tour.id)}` })),
  ];
}
