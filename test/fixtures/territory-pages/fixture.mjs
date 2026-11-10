import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = JSON.parse(readFileSync(new URL('../territory-evidence-current-history-view/recordings.json', import.meta.url))).response;
const contract = JSON.parse(readFileSync(new URL('../../../contracts/carr-interface.v1/mcp_read_contracts/territory-state-board.json', import.meta.url)));
export function territoryFixture(count = 45) {
  const response = { ...base, submarkets: Array.from({ length: count }, (_, i) => ({ ...structuredClone(base.submarkets[i % 2]), city: `Recorded area ${String(i).padStart(4, '0')}` })) };
  assert.equal(response.schema_version, contract.schema_version);
  assert.equal(response.coverage, contract.coverage);
  assert.ok(count <= contract.limit);
  for (const row of response.submarkets) {
    assert.ok(row.city && /^[A-Z]{2}$/.test(row.state));
    assert.ok(contract.conditions.includes(row.condition));
    for (const e of row.evidence) {
      assert.ok(contract.submarkets.evidence.condition.split('|').includes(e.condition));
      assert.ok(e.flag_id && e.source && Number.isFinite(Date.parse(e.observed_at)));
      assert.equal(typeof e.current, 'boolean'); assert.equal(typeof e.expired, 'boolean');
      assert.ok(!e.current || !e.expired);
      assert.ok(e.expires_on === null || /^\d{4}-\d{2}-\d{2}$/.test(e.expires_on));
    }
  }
  return response;
}
