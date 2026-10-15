import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import baseCatalog from '../../contracts/e2e-staging-v1-qualification.v1.json' with { type: 'json' };

export const INVOICE_CLOSE_REQUIREMENT = Object.freeze({ id: 'W15', case: 'invoice-close',
  actions: ['capture-evidence', 'automatic-close', 'close-readback', 'undo-close', 'undo-readback'] });
const catalog = { ...baseCatalog, requirements: [...baseCatalog.requirements, INVOICE_CLOSE_REQUIREMENT] };

const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const pairMatches = (value, sourcePair) => value?.source_commit === sourcePair.source_commit &&
  value?.carr_source_commit === sourcePair.carr_source_commit;
const key = row => JSON.stringify([row.id, row.case, row.action]);
const requirements = catalog.requirements.flatMap(row => row.actions.map(action => ({ id: row.id, case: row.case, action })));
const required = new Set(requirements.map(key));
const catalogHash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function observedV1Action({ id, case: caseId, action, sourcePair, runId, fixtureRun, ui, readback }) {
  if (!required.has(key({ id, case: caseId, action })) || !sha40(sourcePair?.source_commit) ||
      sourcePair.carr_source_commit !== catalog.producer.source_commit || !runId || !uuid(fixtureRun) ||
      !ui || typeof ui !== 'object' || !readback || typeof readback !== 'object')
    throw new Error('V1 journey action source or measured inputs refused');
  return Object.freeze({ id, case: caseId, action, state: 'observed', source_pair: { ...sourcePair },
    run_id: runId, fixture_run: fixtureRun, actor: 'joe', contract_sha256: catalogHash,
    ui_sha256: digest(ui), readback_sha256: digest(readback) });
}

export function qualifyV1Journeys({ sourcePair, runId, fixtureRun, observations, writeCoverage,
  retainedEvidenceVerified, sweepAccepted, companion } = {}) {
  if (catalog.schema !== 'doctorcre-staging-v1-qualification.v1' ||
      createHash('sha256').update(readFileSync(new URL('../../tests/journeys/required-coverage.json', import.meta.url))).digest('hex') !==
        catalog.requirements_source.sha256 ||
      !sha40(sourcePair?.source_commit) || sourcePair.carr_source_commit !== catalog.producer.source_commit ||
      typeof runId !== 'string' || !runId || !uuid(fixtureRun))
    throw new Error('V1 qualification source and accepted coverage contract refused');
  const seen = new Set(), invalid = [];
  for (const row of Array.isArray(observations) ? observations : []) {
    const identity = row && typeof row === 'object' ? key(row) : 'invalid';
    if (!required.has(identity) || seen.has(identity) || row.state !== 'observed' ||
        !pairMatches(row.source_pair, sourcePair) || row.run_id !== runId || row.fixture_run !== fixtureRun ||
        row.actor !== 'joe' || row.contract_sha256 !== catalogHash ||
        !sha256(row.ui_sha256) || !sha256(row.readback_sha256)) {
      invalid.push({ id: row?.id || 'unknown', case: row?.case || 'unknown', action: row?.action || 'unknown' });
      continue;
    }
    seen.add(identity);
  }
  const pending = requirements.filter(row => !seen.has(key(row)));
  const companionRows = Array.isArray(companion) ? companion : [];
  const companionIds = new Set();
  const companionPending = [];
  for (const row of companionRows) {
    if (!catalog.companion_ids.includes(row?.id) || companionIds.has(row.id) ||
        !pairMatches(row.source_pair, sourcePair) || row.run_id !== runId || row.fixture_run !== fixtureRun ||
        row.actor !== 'joe' || row.contract_sha256 !== catalogHash ||
        !sha256(row.ui_sha256) || !sha256(row.readback_sha256) ||
        row.enabled !== true && row.enabled !== false ||
        row.enabled === true && row.state !== 'qualified' ||
        row.enabled === false && row.state !== 'disabled-observed') {
      companionPending.push(row?.id || 'unknown');
      continue;
    }
    companionIds.add(row.id);
  }
  for (const id of catalog.companion_ids) if (!companionIds.has(id)) companionPending.push(id);
  const qualified = pending.length === 0 && invalid.length === 0 && companionPending.length === 0 &&
    writeCoverage === true && retainedEvidenceVerified === true && sweepAccepted === true;
  return Object.freeze({ schema: 'doctorcre-staging-v1-qualification.v1',
    source_pair: { ...sourcePair }, run_id: runId, fixture_run: fixtureRun, contract_sha256: catalogHash,
    expected_actions: requirements.length, observed_actions: seen.size, pending, invalid,
    companion_pending: companionPending, write_scope_reconciled: writeCoverage === true,
    retained_evidence_verified: retainedEvidenceVerified === true, sweep_accepted: sweepAccepted === true,
    full_v1_qualified: qualified });
}

export const V1_REQUIRED_ACTIONS = Object.freeze(requirements.map(row => Object.freeze({ ...row })));
export const V1_QUALIFICATION_SHA256 = catalogHash;
