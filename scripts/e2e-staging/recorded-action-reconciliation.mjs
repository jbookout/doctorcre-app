import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { settledInventory } from './controls.mjs';
import { canonicalIdentity, validateTraversal, canContinueTraversal } from './traversal.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { sweepFindings } from './report.mjs';

const execute = promisify(execFile);
const refusal = value => assert.ok(value, 'Recorded action proof refused; no action or checkpoint was changed');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const actionFields = ['selector', 'name', 'role', 'inputType', 'optionValue', 'href', 'disabled', 'aria', 'workspace', 'options'];
const sameAction = (a, b) => actionFields.every(field => same(a[field], b[field]));
const identity = row => canonicalIdentity(row.identity);
export const recordedActionProducerDigest = async () => hash(await readFile(fileURLToPath(import.meta.url), 'utf8'));

function legacy(row) {
  refusal(typeof row.identity === 'string' && row.identity.startsWith('['));
  // JSON labels may contain "|"; find the end of the JSON prefix first.
  let quoted = false, escaped = false, depth = 0, end = -1;
  for (let i = 0; i < row.identity.length; i++) {
    const char = row.identity[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === '[') depth++;
    if (!quoted && char === ']' && --depth === 0) { end = i; break; }
  }
  refusal(end >= 0 && row.identity[end + 1] === '|');
  const context = JSON.parse(row.identity.slice(0, end + 1));
  const suffix = row.identity.slice(end + 2), url = suffix.split('|')[0];
  refusal(Array.isArray(context) && context.length === 4 && Array.isArray(context[1]));
  return { context, suffix, url };
}

function latestEffect(args, receipt, room) {
  refusal(room.deal_id === args.deal || room.id === args.deal);
  refusal(room.next_step === args.text && (room.next_date || null) === args.next_date);
  refusal(typeof receipt.next_step_id === 'string' && receipt.next_step_id.trim() &&
    typeof receipt.created_at === 'string' && Number.isFinite(Date.parse(receipt.created_at)));
  const steps = (room.thread || []).filter(row => row.kind === 'next_step');
  refusal(steps.length > 0 && steps.every(row => typeof row.id === 'string' && row.id.trim() &&
    typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at))));
  const latest = Math.max(...steps.map(row => Date.parse(row.created_at)));
  const winners = steps.filter(row => Date.parse(row.created_at) === latest);
  refusal(winners.length === 1);
  const current = winners[0];
  refusal(current.id === receipt.next_step_id && current.text === args.text &&
    current.created_at === receipt.created_at);
  const action = receipt.next_action_id
    ? (room.next_actions || []).find(row => row.id === receipt.next_action_id) : null;
  refusal(!receipt.next_action_id || action);
  return { record: args.deal, text: room.next_step, next_date: room.next_date || null,
    step: current, next_action: action || null };
}

function readonlyOpener(screen, entry, index, recordURL) {
  const original = screen.controls.find(row => identity(row) === entry.expected_identity);
  refusal(original?.status === 'OBSERVED' && original.evidence_path &&
    identity(entry.raw_before) === entry.expected_identity &&
    identity(entry.current_before) === entry.expected_identity &&
    sameAction(entry.raw_before, entry.current_before) && sameAction(original, entry.current_before));
  refusal(entry.dom.form === null && entry.dom.disabled === false);
  if (index === 0) {
    refusal(original.selector === '#morningClose' && original.role === 'button' &&
      original.inputType === 'button' && entry.dom.tag === 'BUTTON' &&
      entry.dom.id === 'morningClose' && entry.policy === 'dismiss-morning-brief.v1');
  } else {
    refusal(/^#homeCalendar > div:nth-of-type\(\d+\) > a:nth-of-type\(\d+\)$/.test(original.selector) &&
      original.role === 'link' && entry.dom.tag === 'A' &&
      entry.policy === 'native-record-link.v1' &&
      original.href === recordURL && entry.dom.href === recordURL);
  }
  return original;
}

function readonlyPath(screen, openers, recordURL) {
  refusal(Array.isArray(openers) && openers.length === 2);
  return openers.map((entry, index) => readonlyOpener(screen, entry, index, recordURL));
}

async function rawInventory(page) {
  let raw;
  const proxy = new Proxy(page, { get(target, key) {
    if (key === 'locator') return (...args) => {
      const locator = target.locator(...args);
      return new Proxy(locator, { get(inner, name) {
        if (name === 'evaluateAll') return async (...xs) => {
          const result = await inner.evaluateAll(...xs);
          if (result?.rows) raw = result.rows;
          return result;
        };
        const value = Reflect.get(inner, name);
        return typeof value === 'function' ? value.bind(inner) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const controls = await settledInventory(proxy);
  refusal(raw && same(controls.map(identity), raw.map(identity)));
  return { controls, raw };
}

// Captures one internally bound read observation. Call only in an owned isolated
// browser with the existing staging guard/session and a freshly checked release.
export async function observeRecordedActionReadProof({ page, prior, release, screen, original, queued, openers }) {
  refusal(same(release, prior.release) && page.url() === 'about:blank');
  const old = legacy(original), recordURL = old.url;
  // Admit the complete opener policy BEFORE clicking anything.
  refusal(openers.length === 2 && openers[0].selector === '#morningClose' &&
    openers[0].role === 'button' && openers[0].inputType === 'button' &&
    /^#homeCalendar > div:nth-of-type\(\d+\) > a:nth-of-type\(\d+\)$/.test(openers[1].selector) &&
    openers[1].role === 'link' && openers[1].href === recordURL);
  let blocked = 0;
  const origin = STAGING_ORIGIN;
  const reads = new Set(['get-deal-room', 'deal-room-board', 'morning-brief', 'notification-feed',
    'today-triage', 'correspondence-readiness', 'incident-board', 'current-work-item',
    'read-resource-dashboard', 'schedule-board', 'lead-board', 'read-invoice-tracker', 'list-doc-suggestions']);
  await page.route('**/*', async route => {
    const request = route.request();
    if (['GET', 'HEAD'].includes(request.method())) return route.fallback();
    let body;
    try { body = request.postDataJSON(); } catch {}
    if (request.method() === 'POST' && new URL(request.url()).origin === origin && new URL(request.url()).pathname === '/mcp' &&
        reads.has(body?.params?.name)) return route.fallback();
    blocked++; await route.abort();
  });
  const responses = [], pending = [];
  page.on('response', response => {
    const request = response.request();
    let body;
    try { body = request.postDataJSON(); } catch {}
    if (body?.params?.name !== 'get-deal-room') return;
    pending.push((async () => {
      const data = await response.json();
      const contents = data.result?.content;
      if (response.status() === 200 && !data.error && !data.result?.isError &&
          contents?.length === 1 && contents[0].type === 'text') {
        responses.push({ arguments: body.params.arguments, room: JSON.parse(contents[0].text) });
      }
    })());
  });
  const bootResponse = await page.goto(STAGING_ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  refusal(bootResponse?.ok() && new URL(page.url()).origin === origin && new URL(page.url()).pathname === '/');
  await page.waitForLoadState('networkidle');
  const path = [];
  for (let i = 0; i < openers.length; i++) {
    const listed = await rawInventory(page), opener = openers[i];
    const current = listed.controls.filter(row => identity(row) === identity(opener));
    const raw = listed.raw.filter(row => identity(row) === identity(opener));
    refusal(current.length === 1 && raw.length === 1);
    const dom = await page.locator(opener.selector).evaluate(node => ({
      tag: node.tagName, id: node.id, form: node.closest('form')?.id || null,
      href: node.getAttribute('href'), disabled: node.matches(':disabled,[aria-disabled="true"]'),
    }));
    path.push({ expected_identity: identity(opener), raw_before: raw[0], current_before: current[0],
      policy: i ? 'native-record-link.v1' : 'dismiss-morning-brief.v1', dom });
    readonlyOpener(screen, path.at(-1), i, recordURL);
    await page.locator(opener.selector).click();
    await page.waitForLoadState('networkidle');
  }
  const listed = await rawInventory(page);
  await Promise.all(pending);
  refusal(blocked === 0 && new URL(page.url()).pathname + new URL(page.url()).search === recordURL);
  const matching = listed.controls.filter(row => identity(row) === identity(queued));
  const raw = listed.raw.filter(row => identity(row) === identity(queued));
  refusal(matching.length === 1 && raw.length === 1);
  const currentContext = legacy(raw[0]).context;
  const added = currentContext[1].filter(selector => !old.context[1].includes(selector));
  refusal(added.length === 1);
  const addition = await page.locator(added[0]).evaluate(node => ({
    selector: '', tag: node.tagName, timeline_day: node.getAttribute('data-timeline-day'),
    detail_focus: node.getAttribute('data-detail-focus'),
  }));
  addition.selector = added[0];
  const saveBinding = await page.locator(queued.selector).evaluate(node => ({
    tag: node.tagName, type: node.getAttribute('type'), form_id: node.form?.id || null,
    form_action: node.form?.getAttribute('action') || null, form_method: node.form?.getAttribute('method') || null,
  }));
  const values = await page.locator('#detailNextForm').evaluate(form => ({
    text: form.elements.namedItem('text').value.trim(),
    next_date: form.elements.namedItem('date').value || null,
  }));
  const record = new URL(recordURL, page.url()).searchParams.get('deal');
  const response = responses.filter(row => row.arguments.deal === record).at(-1);
  refusal(response);
  return { schema: 'recorded-action-read-proof.v1', checkpoint_sha256: hash(prior), origin, root_path: '/',
    screen_sha256: hash(screen), source_attempt: screen.attempt_id, release,
    producer_sha256: await recordedActionProducerDigest(), blocked_non_read_requests: blocked,
    observed_at: new Date().toISOString(), observations: [{
      queued_identity: identity(queued), original_identity: identity(original), openers: path,
      raw_current: raw[0], current: matching[0], inventory: listed.controls, raw_inventory: listed.raw,
      addition, save_binding: saveBinding, form_values: values,
      read_response: response,
    }] };
}

async function retainedEvidence(row) {
  const script = fileURLToPath(new URL('./recorded-action-proof.py', import.meta.url));
  const { stdout } = await execute('python3', [script, row.evidence_path, STAGING_ORIGIN], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function recordedActionSourceScreen(prior) {
  const current = prior.screens.find(row => row.target === 'staging-live' && row.path === '/');
  if (!current?.recorded_action_ledger) return current;
  const matches = (prior.history || []).map(entry => entry.screen).filter(row =>
    row.target === current.target && row.path === current.path &&
    row.attempt_id === current.recorded_action_ledger.source_attempt);
  refusal(matches.length === 1);
  return matches[0];
}

// Pure evidence planner. Runtime consumption below revalidates the proof and
// records equivalence separately from measured rows and their seen identities.
export async function planRecordedActionReconciliations({ prior, proof }) {
  refusal(proof.schema === 'recorded-action-read-proof.v1' &&
    proof.checkpoint_sha256 === hash(prior) && same(proof.release, prior.release) &&
    proof.producer_sha256 === await recordedActionProducerDigest() &&
    proof.blocked_non_read_requests === 0 && proof.origin === STAGING_ORIGIN &&
    proof.root_path === '/' && Array.isArray(proof.observations));
  const screen = recordedActionSourceScreen(prior);
  refusal(screen && proof.screen_sha256 === hash(screen) && proof.source_attempt === screen.attempt_id);
  validateTraversal(screen);
  const states = [screen.traversal.active, ...screen.traversal.queue, ...screen.traversal.destructive].filter(Boolean);
  const saves = states.flatMap(state => state.controls.filter(row => row.name === 'Save next step').map(control => ({ state, control })));
  const aliases = [], blocked = [], cache = new Map();
  for (const { state, control } of saves) {
    try {
      const observations = proof.observations.filter(row => row.queued_identity === identity(control));
      refusal(observations.length === 1);
      const observation = observations[0];
      const originals = screen.controls.filter(row => identity(row) === observation.original_identity);
      refusal(originals.length === 1);
      const original = originals[0];
      refusal(original.status === 'OBSERVED' && original.evidence_path &&
        original.name === 'Save next step' && original.role === 'button' && original.inputType === 'submit');
      const old = legacy(original), current = legacy(observation.raw_current);
      refusal(old.context[0] === '#recordPanel' && sameAction(original, control) &&
        sameAction(control, observation.current) && sameAction(observation.current, observation.raw_current));
      const before = old.context[1], after = current.context[1];
      const added = after.filter(selector => !before.includes(selector));
      const dom = observation.addition;
      refusal(same(after.filter(selector => before.includes(selector)), before) &&
        after.length === before.length + 1 && added.length === 1 &&
        dom.selector === added[0] && dom.tag === 'BUTTON' &&
        /^\d{4}-\d\d-\d\d$/.test(dom.timeline_day || '') && dom.detail_focus === 'day:' + dom.timeline_day);
      const derived = canonicalIdentity(JSON.stringify([old.context[0], after, ...old.context.slice(2)]) + '|' + old.suffix);
      refusal(derived === identity(observation.raw_current) && derived === identity(observation.current) &&
        derived === identity(control) && current.url === old.url &&
        (!observation.current.state_url || observation.current.state_url === old.url));
      const sourcePath = readonlyPath(screen, observation.openers, old.url);
      const expectedOpeners = sourcePath.map(identity);
      const queuedOpeners = state.openers.map(identity);
      const stripped = queuedOpeners.at(-1) === identity(original) ? queuedOpeners.slice(0, -1) : queuedOpeners;
      refusal(same(stripped, expectedOpeners));
      if (!cache.has(identity(original))) cache.set(identity(original), await retainedEvidence(original));
      const evidence = cache.get(identity(original)), args = evidence.arguments;
      const binding = observation.save_binding;
      refusal(binding?.tag === 'BUTTON' && binding.type === 'submit' &&
        binding.form_id === 'detailNextForm' && binding.form_action === null && binding.form_method === null);
      refusal(new URL(old.url, 'https://staging.invalid').searchParams.get('deal') === args.deal &&
        same(observation.form_values, { text: args.text, next_date: args.next_date }) &&
        observation.read_response.arguments.deal === args.deal);
      const oldEffect = latestEffect(args, evidence.receipt, evidence.readback);
      const currentEffect = latestEffect(args, evidence.receipt, observation.read_response.room);
      refusal(same(oldEffect, currentEffect));
      aliases.push({
        schema: 'recorded-action-reconciliation.v1', decision: 'already-measured-equivalent',
        measurement_credit: 'original observation only', action_executed: false,
        queued_identity: identity(control), original_identity: identity(original),
        original_key: original.key, original_evidence: {
          png: original.evidence_path, trace: original.evidence_path.replace(/\.png$/, '.zip'),
          png_sha256: evidence.png_sha256, trace_sha256: evidence.trace_sha256,
        },
        source_commit: prior.release.source_commit, carr_source_commit: prior.release.carr_source_commit,
        record_sha256: hash(args.deal), verb: 'set-next-step',
        value_sha256: hash({ text: args.text, next_date: args.next_date }),
        effect_sha256: hash(oldEffect), original_idempotency_key_sha256: hash(args.idempotency_key),
        catalog_delta: { before_sha256: hash(before), after_sha256: hash(after), addition: dom },
        retained_read_openers: expectedOpeners, removed_write_opener: queuedOpeners.length > stripped.length ? identity(original) : null,
        checkpoint_sha256: proof.checkpoint_sha256, read_proof_sha256: hash(proof),
        producer_sha256: proof.producer_sha256,
        evidence_reader_sha256: hash(await readFile(new URL('./recorded-action-proof.py', import.meta.url), 'utf8')),
        observed_at: proof.observed_at,
      });
    } catch {
      blocked.push({ queued_identity: identity(control), reason: 'Exact record/action/value/effect, catalog and read-path equivalence was not proved' });
    }
  }
  return { schema: 'recorded-action-plan.v1', checkpoint_sha256: hash(prior), aliases, blocked,
    original_observations_changed: false, seen_changed: false, runtime_integration: 'not implemented; independent review required',
    can_resume: false };
}

// Admission decisions for review/tests only. There is deliberately no execute
// result and no resumed-sweep integration until the explicit ledger is reviewed.
export function admitRecordedAction(plan, { queued_identity, value_sha256, effect_sha256, as_opener = false }) {
  refusal(as_opener === false);
  const aliases = plan.aliases.filter(row => row.queued_identity === queued_identity);
  refusal(aliases.length === 1 && aliases[0].value_sha256 === value_sha256 &&
    aliases[0].effect_sha256 === effect_sha256);
  return { decision: 'already-measured-equivalent', reconciliation: structuredClone(aliases[0]), action_executed: false };
}


const runtimes = new WeakSet();
export const isRecordedActionRuntime = runtime => runtimes.has(runtime);

// Prepare a new attempt without changing the retained failed attempt or creating
// a measurement. The complete original remains in history, including failures.
export async function createRecordedActionContinuation({ prior, proof }) {
  const plan = await planRecordedActionReconciliations({ prior, proof });
  const fresh = () => refusal(Number.isFinite(Date.parse(proof.observed_at)) &&
    Date.now() >= Date.parse(proof.observed_at) && Date.now() - Date.parse(proof.observed_at) <= 300_000);
  fresh();
  refusal(plan.aliases.length > 0);
  const original = recordedActionSourceScreen(prior);
  const observations = proof.observations;
  const mappings = new Map(), paths = new Map(), aliases = new Map(plan.aliases.map(row => [row.queued_identity, row]));
  for (const alias of plan.aliases) {
    const observation = observations.find(row => row.queued_identity === alias.queued_identity);
    refusal(Array.isArray(observation.inventory) && Array.isArray(observation.raw_inventory) &&
      same(observation.inventory.map(identity), observation.raw_inventory.map(identity)));
    const old = legacy(original.controls.find(row => identity(row) === alias.original_identity));
    const after = legacy(observation.raw_current).context[1];
    const roots = observation.openers.map(entry => original.controls.find(row => identity(row) === entry.expected_identity));
    paths.set(alias.original_identity, roots);
    const candidates = [...original.controls,
      ...[original.traversal.active, ...original.traversal.queue, ...original.traversal.destructive]
        .filter(Boolean).flatMap(state => state.controls || [])];
    for (const row of candidates) {
      let binding;
      try { binding = legacy(row); } catch { continue; }
      if (binding.url !== old.url || !same(binding.context, old.context)) continue;
      const derived = canonicalIdentity(JSON.stringify([old.context[0], after, ...old.context.slice(2)]) + '|' + binding.suffix);
      const current = observation.inventory.filter(control => identity(control) === derived && sameAction(control, row));
      const raw = observation.raw_inventory.filter(control => identity(control) === derived && sameAction(control, row));
      if (current.length !== 1 || raw.length !== 1) continue;
      const previous = mappings.get(identity(row));
      refusal(!previous || identity(previous) === derived);
      mappings.set(identity(row), current[0]);
    }
  }
  const recovered = structuredClone(prior), screen = recovered.screens.find(row => row.target === 'staging-live' && row.path === '/');
  const restoring = Boolean(screen.recorded_action_ledger);
  if (restoring) {
    validateTraversal(screen);
    refusal(canContinueTraversal(screen));
    const ledger = screen.recorded_action_ledger;
    refusal(ledger.schema === 'recorded-action-runtime.v1' && same(ledger.release, prior.release) &&
      ledger.source_attempt === original.attempt_id &&
      /^[a-f0-9]{64}$/.test(ledger.checkpoint_sha256) && /^[a-f0-9]{64}$/.test(ledger.proof_sha256) &&
      ledger.aliases.length === plan.aliases.length);
    const verificationFields = new Set(['checkpoint_sha256', 'read_proof_sha256', 'observed_at']);
    const semantic = alias => Object.fromEntries(Object.entries(alias).filter(([key]) => !verificationFields.has(key)));
    for (const stored of ledger.aliases) {
      const fresh = plan.aliases.filter(row => row.queued_identity === stored.queued_identity);
      refusal(fresh.length === 1 && same(semantic(stored), semantic(fresh[0])) &&
        stored.checkpoint_sha256 === ledger.checkpoint_sha256 && stored.read_proof_sha256 === ledger.proof_sha256);
    }
    // Existing audit records, resolved credit, measured prefix and attempt are
    // immutable. A fresh restore observation is a separate verification record.
    ledger.restore_verifications ||= [];
    ledger.restore_verifications.push({ checkpoint_sha256: hash(prior), read_proof_sha256: hash(proof),
      observed_at: proof.observed_at, source_attempt: original.attempt_id,
      producer_sha256: proof.producer_sha256 });
    plan.aliases = structuredClone(ledger.aliases);
    aliases.clear();
    for (const alias of ledger.aliases) aliases.set(alias.queued_identity, alias);
  } else {
    const failures = screen.controls.filter(row => ['ERROR', 'UNREACHABLE'].includes(row.status));
    refusal(!screen.exhausted && !screen.traversal.pending_discovery);
    // Only a validation failure without a press is recoverable here. Ambiguous
    // press/evidence failures require an independent receipt/read reconciliation.
    refusal(!screen.failure || screen.failure.phase === 'frontier-validation' &&
      screen.failure.code === 'control-state-changed' && failures.length === 1 &&
      failures[0] === screen.controls.at(-1) && failures[0].status === 'UNREACHABLE' &&
      mappings.has(identity(failures[0])));
    const states = [screen.traversal.active, ...screen.traversal.queue, ...screen.traversal.destructive].filter(Boolean);
    for (const state of states) {
      const last = state.openers.at(-1), roots = paths.get(last && identity(last));
      if (roots) {
        refusal(same(state.openers.slice(0, -1).map(identity), roots.map(identity)));
        state.openers = structuredClone(roots);
      }
      state.controls = state.controls?.map(row => structuredClone(mappings.get(identity(row)) || row)) || null;
    }
    if (failures.length) {
      const row = mappings.get(identity(failures[0]));
      const roots = [...paths.values()][0];
      if (!states.some(state => state.controls?.some(control => identity(control) === identity(row))))
        screen.traversal.queue.unshift({ openers: structuredClone(roots), controls: [structuredClone(row)] });
    }
    recovered.history ||= [];
    recovered.history.push({ screen: structuredClone(original), findings: sweepFindings([original]) });
    screen.attempt_id = randomUUID();
    screen.controls = screen.controls.filter(row => !['ERROR', 'UNREACHABLE'].includes(row.status));
    screen.failure = null;
    screen.prior_failures = [...(screen.prior_failures || []),
      ...(original.failure ? [{ ...original.failure, retained_controls: screen.controls.length }] : [])];
    screen.traversal.seen = screen.controls.map(row => identity(row));
    // Deduplicate only exact queued identities after proved catalog rebinding.
    const scheduled = new Set(), seen = new Set(screen.traversal.seen);
    const filter = state => {
      if (!state) return null;
      if (state.controls) state.controls = state.controls.filter(row =>
        !seen.has(identity(row)) && !scheduled.has(identity(row)) && scheduled.add(identity(row)));
      return state.controls?.length === 0 ? null : state;
    };
    screen.traversal.active = filter(screen.traversal.active);
    screen.traversal.queue = screen.traversal.queue.map(filter).filter(Boolean);
    screen.traversal.destructive = screen.traversal.destructive.map(filter).filter(Boolean);
    screen.traversal.known_remaining = scheduled.size;
    screen.traversal.max_opener_depth = Math.max(0, ...[screen.traversal.active,
      ...screen.traversal.queue, ...screen.traversal.destructive].filter(Boolean).map(state => state.openers.length));
    screen.recorded_action_ledger = { schema: 'recorded-action-runtime.v1', release: structuredClone(prior.release),
      source_attempt: original.attempt_id, checkpoint_sha256: hash(prior), proof_sha256: hash(proof),
      aliases: structuredClone(plan.aliases), resolved: [],
      recovered_failure_identity: failures.length ? identity(failures[0]) : null };
  }
  validateTraversal(screen);
  const runtime = {
    screen_sha256: hash(screen),
    original_sha256: hash(prior),
    guardOpener(opener) {
      refusal(!paths.has(identity(opener)) && opener.name !== 'Save next step' && opener.inputType !== 'submit');
    },
    async consume(page, control) {
      refusal(new URL(page.url()).origin === STAGING_ORIGIN);
      const alias = aliases.get(identity(control));
      if (!alias) return null;
      // Re-run the original evidence reader at consumption, not just preparation.
      const source = original.controls.find(row => identity(row) === alias.original_identity);
      const evidence = await retainedEvidence(source);
      refusal(evidence.png_sha256 === alias.original_evidence.png_sha256 &&
        evidence.trace_sha256 === alias.original_evidence.trace_sha256);
      const listed = await settledInventory(page);
      refusal(listed.filter(row => identity(row) === alias.queued_identity && sameAction(row, control)).length === 1);
      const binding = await page.locator(control.selector).evaluate(node => ({
        tag: node.tagName, type: node.getAttribute('type'), form_id: node.form?.id || null,
        form_action: node.form?.getAttribute('action') || null, form_method: node.form?.getAttribute('method') || null,
      }));
      refusal(same(binding, observations.find(row => row.queued_identity === alias.queued_identity).save_binding));
      const values = await page.locator('#detailNextForm').evaluate(form => ({
        text: form.elements.namedItem('text').value.trim(),
        next_date: form.elements.namedItem('date').value || null,
      }));
      refusal(hash(values) === alias.value_sha256);
      const read = await page.evaluate(async ({ origin, record }) => {
        const response = await fetch(origin + '/mcp', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'recorded-action-read',
            method: 'tools/call', params: { name: 'get-deal-room', arguments: { deal: record } } }) });
        const body = await response.json(), content = body.result?.content;
        if (!response.ok || body.error || body.result?.isError || content?.length !== 1 || content[0].type !== 'text')
          return null;
        return JSON.parse(content[0].text);
      }, { origin: STAGING_ORIGIN, record: evidence.arguments.deal });
      refusal(hash(latestEffect(evidence.arguments, evidence.receipt, read)) === alias.effect_sha256);
      return admitRecordedAction(plan, { queued_identity: alias.queued_identity,
        value_sha256: hash(values), effect_sha256: alias.effect_sha256 }).reconciliation;
    },
  };
  runtimes.add(runtime);
  return { prior: recovered, runtime, plan: { ...plan, runtime_integration: 'validated traversal consumption', restored_existing_attempt: restoring, can_resume: true } };
}
