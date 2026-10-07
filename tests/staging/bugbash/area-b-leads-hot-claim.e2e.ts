import { randomUUID } from 'node:crypto';
import { expect } from 'e2e';
import { verbTest as test } from '../api/fixture.ts';

// Repro: the "5 hottest leads to claim" empty state reads "No New leads" although the New column holds claimed (owned) New leads.
// js/leads-workspace-app.js falls back to '<p class="empty">No New leads</p>' when hottestLeads() (stage new AND no owner) is empty.
test('[leads-hot-claim] empty hot list does not claim there are no New leads', { session: 'staging-partner', tags: ['bugbash', 'area-b'] }, async ({ app, screen, verb }) => {
  const name = `E2E ${Date.now()} hot repro`;
  const ev = { sources: [{ url: 'https://example.com/e2e-staging-fixture', observed_at: new Date().toISOString() }], field_evidence: Object.fromEntries(['name', 'city', 'state', 'company', 'phone', 'specialty', 'market'].map(f => [f, [0]])), discrepancies: [] };
  const party = await verb('add-party', { idempotency_key: randomUUID(), name, kind: 'person', org_name: `${name} Dental`, phone: '(850) 555-0170', city: 'Pensacola', state: 'FL', specialty: 'Dentistry', force_new: true, research_evidence: ev });
  const lead = await verb('new-lead', { idempotency_key: randomUUID(), party_id: party.data.party_id, stage: 'new', score: 80 });
  try {
    await app.open('/leads');
    const brief = screen.getByRole('button', 'Dismiss morning brief');
    if (await brief.isVisible().catch(() => false)) await brief.tap();
    await expect(screen.getByRole('heading', { name: /^New [1-9]/ })).toBeVisible();
    await expect(screen.getByText('No New leads')).toBeHidden();
  } finally {
    const board = await verb('lead-board', {});
    const row = board.data.leads.find((l: any) => l.id === lead.data.lead_id);
    if (row) await verb('update-lead', { idempotency_key: randomUUID(), lead: row.id, base_version: row.base_version, fields: { suppressed: true } });
  }
});
