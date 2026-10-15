import { createHash, randomUUID } from 'node:crypto';
import { STAGING_ORIGIN } from './session.mjs';
import { observedV1Action } from './v1-qualification.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = reason => { throw Object.assign(new Error(reason), { code: reason, fixturePolicy: true }); };
const exact = (actual, expected) => hash(actual) === hash(expected);
const operations = ['record-deal-invoice', 'advance-leads', 'undo-invoice-close'];
const mailbox = 'invoice-fixture@staging.invalid';

function fixture(plan) {
  const deal = plan.records?.deal, client = plan.records?.client;
  if (!uuid(deal?.id) || plan.receipts?.deal?.deal_id !== deal.id || !uuid(client?.id) ||
      plan.receipts?.client?.client_id !== client.id || !deal.name?.includes(plan.run) ||
      !Number.isFinite(Date.parse(plan.observed_at))) fail('invoice-close-fixture-unproved');
  return { deal: deal.id, name: deal.name, client: client.name,
    evidence: `local-mail:staging-invoice:${plan.run}:${deal.id}`, occurred_at: plan.observed_at };
}

function template(plan, step) {
  const f = fixture(plan), journal = plan.invoice_close_journey;
  if (step === 'capture') return { native_ref: f.evidence, from_address: mailbox,
    deal_name: f.name, client_name: f.client, occurred_at: f.occurred_at };
  const invoice = journal?.steps?.capture?.receipt?.invoice_id;
  if (!uuid(invoice)) fail('invoice-close-capture-unproved');
  if (step === 'close') {
    if (journal.bounded_preview?.scope_enforced !== true || !exact(journal.bounded_preview.staging_scope,
        { contract: 'staging-invoice-close.v1', fixture_run: plan.run, invoice_id: invoice, deal_id: f.deal }))
      fail('invoice-close-scope-unproved');
    return { dry_run: false, time_zone: 'America/Chicago',
      staging_fixture: { fixture_run: plan.run, invoice_id: invoice, deal_id: f.deal } };
  }
  if (step === 'undo') {
    const latest = journal?.latest_deal;
    if (journal?.steps?.close?.state !== 'observed' || latest?.id !== f.deal || latest.phase !== 'closed' ||
        latest.invoiced_on !== f.occurred_at.slice(0, 10) || !Number.isSafeInteger(latest.base_version) ||
        latest.base_version < 1) fail('invoice-close-fresh-version-unproved');
    return { invoice_id: invoice, base_version: latest.base_version };
  }
  fail('invoice-close-step-unproved');
}

function receiptMatches(step, receipt, plan) {
  const f = fixture(plan), journal = plan.invoice_close_journey, invoice = journal.steps.capture?.receipt?.invoice_id;
  if (receipt?.ok !== true || receipt.replayed === true || receipt.error) return false;
  if (step === 'capture') return uuid(receipt.invoice_id) && receipt.evidence_ref === f.evidence;
  if (step === 'close') {
    const scope = receipt.staging_scope, closes = receipt.invoice_closes;
    return scope?.contract === 'staging-invoice-close.v1' && scope.fixture_run === plan.run &&
      scope.deal_id === f.deal && scope.invoice_id === invoice && receipt.sent === false &&
      Array.isArray(receipt.moves) && receipt.moves.length === 0 && receipt.drafts_prepared === 0 &&
      Array.isArray(closes) && closes.length === 1 && closes[0].invoice_id === invoice &&
      closes[0].deal_id === f.deal && closes[0].status === 'applied' && closes[0].to_phase === 'closed' &&
      closes[0].from_phase === journal.before.phase && closes[0].evidence_ref === f.evidence &&
      closes[0].invoiced_on === f.occurred_at.slice(0, 10);
  }
  return receipt.deal_id === f.deal && receipt.phase === journal.before.phase &&
    receipt.invoiced_on === journal.before.invoiced_on && uuid(receipt.undone_by);
}

export function createInvoiceCloseGuard({ currentPlan, persistPlan, locked, run }) {
  return {
    async admitInvoiceClose({ phase, step, release, observation }) {
      return locked(async () => {
        const plan = await currentPlan(), f = fixture(plan);
        if (!exact(release, plan.release)) fail('invoice-close-source-unproved');
        const journal = plan.invoice_close_journey;
        if (phase === 'status') return structuredClone(journal?.steps?.[step] ?? null);
        if (phase === 'observe') {
          const row = journal?.steps?.[step], latest = journal?.latest_deal, queue = journal?.latest_queue;
          const invoice = journal?.steps?.capture?.receipt?.invoice_id;
          const move = queue?.moves?.filter(item => item.invoice_id === invoice);
          const target = step === 'close' ? 'applied' : 'undone';
          if (!['close', 'undo'].includes(step) || row?.state !== 'acknowledged' ||
              latest?.id !== f.deal || move?.length !== 1 || move[0].deal_id !== f.deal ||
              move[0].status !== target || move[0].evidence_ref !== f.evidence ||
              latest.phase !== (step === 'close' ? 'closed' : journal.before.phase) ||
              latest.invoiced_on !== (step === 'close' ? f.occurred_at.slice(0, 10) : journal.before.invoiced_on) ||
              ![journal.deal_read_at, journal.queue_read_at, row.completed_at].every(Number.isFinite) ||
              journal.deal_read_at < row.completed_at || journal.queue_read_at < row.completed_at ||
              observation?.invoice_id !== invoice || observation?.state !== target)
            fail('invoice-close-readback-unproved');
          row.state = 'observed'; row.observation = structuredClone(observation);
          row.readback_sha256 = hash({ latest, move: move[0] });
          await persistPlan(plan);
          return structuredClone(row);
        }
        if (phase !== 'admit' || !['capture', 'close', 'undo'].includes(step)) fail('invoice-close-step-unproved');
        if (journal?.steps?.[step]) fail('invoice-close-never-replay');
        if (step === 'capture' && (!journal?.latest_deal || journal.latest_deal.id !== f.deal ||
            journal.latest_deal.phase !== 'pending' || journal.latest_deal.invoiced_on !== null))
          fail('invoice-close-before-unproved');
        if (step === 'close' && journal?.steps?.capture?.state !== 'acknowledged') fail('invoice-close-capture-unproved');
        const args = template(plan, step);
        if (step === 'capture') journal.before = structuredClone(journal.latest_deal);
        const row = { step, operation: operations[['capture', 'close', 'undo'].indexOf(step)],
          arguments: { ...args, idempotency_key: randomUUID() }, state: 'admitted' };
        journal.steps[step] = row;
        await persistPlan(plan);
        return structuredClone(row);
      });
    },
    async handle(request, forward) {
      let body;
      try { body = request.postDataJSON(); } catch { return { handled: false }; }
      const url = new URL(request.url()), name = body?.params?.name, args = body?.params?.arguments;
      if (url.origin !== STAGING_ORIGIN || url.pathname !== '/mcp' || url.search || url.hash ||
          request.method() !== 'POST' || body?.jsonrpc !== '2.0' || body.method !== 'tools/call') return { handled: false };
      if (!operations.includes(name) && !['read-deal-reconciliation', 'invoice-close-queue', 'lead-stage-preview'].includes(name))
        return { handled: false };
      const candidate = await currentPlan();
      if (!operations.includes(name) && !candidate.records?.deal?.id) return { handled: false };
      const plan = candidate, f = fixture(plan);
      const dealRead = name === 'read-deal-reconciliation' && exact(args, { deal: f.deal });
      const queueRead = name === 'invoice-close-queue' && exact(args, {});
      const previewRead = name === 'lead-stage-preview' && exact(args, { staging_fixture: {
        fixture_run: plan.run, invoice_id: plan.invoice_close_journey?.steps?.capture?.receipt?.invoice_id, deal_id: f.deal } });
      if (name === 'lead-stage-preview' && !previewRead) fail('invoice-close-scope-unproved');
      if (!operations.includes(name) && !dealRead && !queueRead && !previewRead) return { handled: false };
      if (!Number.isSafeInteger(body.id) && !(typeof body.id === 'string' && body.id)) fail('invoice-close-request-unproved');
      if (dealRead || queueRead || previewRead) {
        const response = await run.http(forward);
        let rpc, result;
        try { rpc = await response.json(); result = JSON.parse(rpc.result.content[0].text); } catch { fail('invoice-close-read-unproved'); }
        if (response.status() !== 200 || rpc.id !== body.id || rpc.jsonrpc !== '2.0' || rpc.error ||
            rpc.result.isError || rpc.result.content.length !== 1 || rpc.result.content[0].type !== 'text') fail('invoice-close-read-unproved');
        await locked(async () => {
          const current = await currentPlan();
          current.invoice_close_journey ||= { steps: {} };
          const journal = current.invoice_close_journey;
          if (previewRead) {
            const expected = { contract: 'staging-invoice-close.v1', ...args.staging_fixture };
            if (result.scope_enforced !== true || !exact(result.staging_scope, expected) ||
                result.sent !== false || !Array.isArray(result.moves) || result.moves.length !== 0 ||
                result.drafts_prepared !== 0 || result.invoice_closes?.length !== 1 ||
                result.invoice_closes[0].deal_id !== f.deal || result.invoice_closes[0].invoice_id !== expected.invoice_id ||
                result.invoice_closes[0].evidence_ref !== f.evidence || result.invoice_closes[0].status !== 'applied')
              fail('invoice-close-scope-unproved');
            journal.bounded_preview = result;
          }
          else if (dealRead) { journal.latest_deal = result; journal.deal_read_at = Date.now(); }
          else { journal.latest_queue = result; journal.queue_read_at = Date.now(); }
          await persistPlan(current);
        });
        return { handled: true, response };
      }
      const step = ['capture', 'close', 'undo'][operations.indexOf(name)];
      await locked(async () => {
        const current = await currentPlan(), row = current.invoice_close_journey?.steps?.[step];
        if (row?.state !== 'admitted' || !exact(row.arguments, args) ||
            current.invoice_close_journey.steps[step].operation !== name) fail('invoice-close-request-unproved');
        row.state = 'inflight'; await persistPlan(current);
      });
      let response;
      try {
        response = await run.http(forward);
        await locked(async () => {
          const current = await currentPlan(), row = current.invoice_close_journey.steps[step];
          let rpc, receipt;
          try { rpc = await response.json(); receipt = JSON.parse(rpc.result.content[0].text); } catch {}
          const acknowledged = response.status() === 200 && rpc?.jsonrpc === '2.0' && rpc.id === body.id &&
            !rpc.error && !rpc.result?.isError && rpc.result?.content?.length === 1 && rpc.result.content[0].type === 'text' &&
            receiptMatches(step, receipt, current);
          row.state = acknowledged ? 'acknowledged' : 'unresolved'; row.completed_at = Date.now();
          row.response_sha256 = hash(rpc ?? null);
          if (acknowledged) row.receipt = receipt;
          await persistPlan(current);
          if (!acknowledged) fail('invoice-close-outcome-unresolved');
        });
      } catch (error) {
        await locked(async () => {
          const current = await currentPlan(), row = current.invoice_close_journey.steps[step];
          if (row.state === 'inflight') { row.state = 'unresolved'; await persistPlan(current); }
        });
        throw error;
      }
      return { handled: true, response };
    },
    async assertCoverage() {
      const plan = await currentPlan(), steps = plan.invoice_close_journey?.steps ?? {};
      for (const [step, row] of Object.entries(steps)) {
        if (row.state !== (step === 'capture' ? 'acknowledged' : 'observed') ||
            !receiptMatches(step, row.receipt, plan) || !row.response_sha256 ||
            step !== 'capture' && !row.readback_sha256) fail('invoice-close-coverage-incomplete');
      }
    },
  };
}

export async function runInvoiceCloseJourney({ page, fixtureGuard, release, plan, run }) {
  run.check();
  const rpc = (name, args) => page.evaluate(async ({ name, args }) => {
    const { createMcpRequests } = await import('/js/mcp-requests.mjs');
    const outcome = await createMcpRequests() (name, args);
    if (outcome.kind !== 'payload' || outcome.isError) throw new Error('Invoice close operation unconfirmed');
    return outcome.payload;
  }, { name, args });
  const f = fixture(plan), binding = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
  const proof = (action, ui, readback) => observedV1Action({ id: 'W15', case: 'invoice-close', action,
    sourcePair: binding, runId: run.snapshot().id, fixtureRun: plan.run, ui, readback });
  const priorCapture = await fixtureGuard.admitInvoiceClose({ phase: 'status', step: 'capture', release: binding });
  if (priorCapture) {
    const closed = await fixtureGuard.admitInvoiceClose({ phase: 'status', step: 'close', release: binding });
    const undone = await fixtureGuard.admitInvoiceClose({ phase: 'status', step: 'undo', release: binding });
    if (priorCapture.state !== 'acknowledged' || closed?.state !== 'observed' || undone?.state !== 'observed')
      fail('invoice-close-never-replay');
    await fixtureGuard.assertCoverage();
    return { state: 'INVOICE_CLOSE_UNDO_OBSERVED', actions: [
      proof('capture-evidence', { invoice_id: priorCapture.receipt.invoice_id, evidence_ref: f.evidence }, priorCapture),
      proof('automatic-close', closed.observation, closed), proof('close-readback', closed.observation, closed),
      proof('undo-close', undone.observation, undone), proof('undo-readback', undone.observation, undone),
    ] };
  }
  const call = async (step, operation) => {
    const prior = await fixtureGuard.admitInvoiceClose({ phase: 'status', step, release: binding });
    if (prior) fail('invoice-close-never-replay');
    const row = await fixtureGuard.admitInvoiceClose({ phase: 'admit', step, release: binding });
    await rpc(operation, row.arguments);
    return fixtureGuard.admitInvoiceClose({ phase: 'status', step, release: binding });
  };
  await rpc('read-deal-reconciliation', { deal: f.deal });
  const captured = await call('capture', 'record-deal-invoice');
  const invoice = captured?.receipt?.invoice_id;
  if (!uuid(invoice)) fail('invoice-close-capture-unproved');
  const actions = [];
  actions.push(proof('capture-evidence', { invoice_id: invoice, evidence_ref: f.evidence }, captured));
  for (const [step, operation, state] of [['close', 'advance-leads', 'applied'], ['undo', 'undo-invoice-close', 'undone']]) {
    await rpc('read-deal-reconciliation', { deal: f.deal });
    if (step === 'close') await rpc('lead-stage-preview', { staging_fixture: {
      fixture_run: plan.run, invoice_id: invoice, deal_id: f.deal } });
    await call(step, operation);
    await rpc('read-deal-reconciliation', { deal: f.deal });
    await rpc('invoice-close-queue', {});
    const observation = { invoice_id: invoice, state };
    const observed = await fixtureGuard.admitInvoiceClose({ phase: 'observe', step, release: binding, observation });
    actions.push(proof(step === 'close' ? 'automatic-close' : 'undo-close', observation, observed),
      proof(step === 'close' ? 'close-readback' : 'undo-readback', observation, observed));
  }
  await fixtureGuard.assertCoverage();
  return { state: 'INVOICE_CLOSE_UNDO_OBSERVED', actions };
}
