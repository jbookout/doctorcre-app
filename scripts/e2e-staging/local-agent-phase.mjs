// A local, attended staging fixture for the W4 automatic badge/Undo seam.
// This proves an agent-caused phase event. It does not prove Doc authorship or
// document inference, which remain separate unqualified requirements.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireSupervisedRun } from './run-limits.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
export const LOCAL_AGENT_PHASE_REASON = 'Fictional staging agent advanced an invented deal for W4 badge and Undo verification.';
const REASON = LOCAL_AGENT_PHASE_REASON;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = code => { throw Object.assign(new Error('W4 local agent fixture refused'), { code }); };
const required = (condition, code) => { if (!condition) refuse(code); };
const samePair = (a, b) => a?.source_commit === b?.source_commit && a?.carr_source_commit === b?.carr_source_commit;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const MAX_LOCAL_CREDENTIAL_BYTES = 64 * 1024;
const MAX_LOCAL_JOURNAL_BYTES = 64 * 1024;

export function parseLocalAgentRpc(envelope, id) {
  required(envelope?.jsonrpc === '2.0' && envelope.id === id && !envelope.error &&
    envelope.result?.isError !== true && envelope.result?.content?.length === 1 &&
    envelope.result.content[0].type === 'text', 'agent-rpc-refused');
  let value;
  try { value = JSON.parse(envelope.result.content[0].text); } catch { refuse('agent-rpc-refused'); }
  required(value && typeof value === 'object' && !Array.isArray(value) && !value.error &&
    value.ok !== false, 'agent-rpc-refused');
  return value;
}

async function privateFolder(path) {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const dir = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await dir.stat();
    required(stat.isDirectory() && stat.nlink >= 1 && (stat.mode & 0o777) === 0o700 &&
      await realpath(folder) === resolve(folder), 'journal-directory-unsafe');
    const parent = await open(dirname(folder), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return dir;
  } catch (error) { await dir.close(); throw error; }
}

async function secureJournal(path, value, run, exclusive = false) {
  const data = JSON.stringify(value) + '\n';
  required(Buffer.byteLength(data) <= MAX_LOCAL_JOURNAL_BYTES, 'journal-file-unsafe');
  run.reserveBytes(Buffer.byteLength(data));
  const dir = await privateFolder(path);
  try {
    const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    if (!exclusive) {
      // The only allowed replacement is our own private regular journal.
      const previous = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const prior = await previous.stat();
        required(prior.isFile() && prior.nlink === 1 && prior.uid === process.getuid?.() &&
          (prior.mode & 0o777) === 0o600, 'journal-file-unsafe');
      } finally { await previous.close(); }
      const { rename } = await import('node:fs/promises');
      await rename(target, path);
    }
    await dir.sync();
  } finally { await dir.close(); }
}

async function existingJournal(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; refuse('journal-file-unsafe'); }
  try {
    const stat = await file.stat();
    required(stat.isFile() && stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_LOCAL_JOURNAL_BYTES,
      'journal-file-unsafe');
    const buffer = Buffer.alloc(MAX_LOCAL_JOURNAL_BYTES + 1);
    let total = 0;
    while (total <= MAX_LOCAL_JOURNAL_BYTES) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) return JSON.parse(buffer.toString('utf8', 0, total));
      total += bytesRead;
    }
    refuse('journal-file-unsafe');
  } catch { refuse('journal-file-unsafe'); }
  finally { await file.close(); }
}

export async function readLocalAgentTokenFile(path, securityIssue) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return ''; refuse('local-credential-file-unsafe'); }
  try {
    const stat = await file.stat();
    required(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_LOCAL_CREDENTIAL_BYTES &&
      !securityIssue({ mode: stat.mode, uid: stat.uid,
        isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() }, process.getuid?.()),
    'local-credential-file-unsafe');
    const buffer = Buffer.alloc(MAX_LOCAL_CREDENTIAL_BYTES + 1);
    let total = 0;
    while (total <= MAX_LOCAL_CREDENTIAL_BYTES) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) return buffer.toString('utf8', 0, total);
      total += bytesRead;
    }
    refuse('local-credential-file-unsafe');
  } catch { refuse('local-credential-file-unsafe'); }
  finally { await file.close(); }
}

// Runs the exact checked-out CARR credential selector locally. No token enters
// argv, a global environment setting, an artifact, or this module's result.
// The token is used only in a manual-redirect HTTPS request to staging CARR.
export async function createLocalAgentRpc({ carrCheckout, fetcher = fetch, environment = process.env } = {}) {
  required(typeof carrCheckout === 'string' && carrCheckout.length > 0, 'carr-checkout-required');
  const checkout = await realpath(carrCheckout);
  const { stdout } = await exec('git', ['-C', checkout, 'rev-parse', 'HEAD'], { timeout: 5000 });
  required(stdout.trim() === contract.producer.source_commit, 'carr-source-mismatch');
  const { stdout: changed } = await exec('git', ['-C', checkout, 'status', '--porcelain', '--',
    'mcp-server/local-client-auth.mjs'], { timeout: 5000 });
  required(!changed.trim(), 'carr-credential-resolver-changed');
  const modulePath = join(checkout, 'mcp-server', 'local-client-auth.mjs');
  required(await realpath(modulePath) === modulePath, 'carr-credential-resolver-unsafe');
  const { selectLocalClientCredential, tokenFileSecurityIssue } = await import(pathToFileURL(modulePath));
  const filePath = join(homedir(), '.config', 'carr', 'mcp-tokens.env');
  const tokenFile = await readLocalAgentTokenFile(filePath, tokenFileSecurityIssue);
  const credential = selectLocalClientCredential({
    CARR_MCP_CLIENT_PROFILE: 'local', CARR_MCP_LOCAL_TOKEN: environment.CARR_MCP_LOCAL_TOKEN,
  }, tokenFile);
  required(credential.profile === 'local' && credential.token, 'local-agent-credential-unavailable');
  const endpoint = contract.carr_origin + '/mcp';
  return async (name, args, { signal, timeout }) => {
    required(['deal-room-board', 'get-deal-room', 'patch-deal-field', 'read-doc-activity'].includes(name),
      'agent-operation-refused');
    const id = randomUUID();
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.any([
      signal, AbortSignal.timeout(timeout)]), headers: {
      'content-type': 'application/json', authorization: `Bearer ${credential.token}`,
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: args } }) });
    required(response.status === 200 && new URL(response.url).href === endpoint, 'agent-transport-refused');
    return parseLocalAgentRpc(await response.json(), id);
  };
}

export async function produceLocalAgentPhase({ plan, release, run, carrCheckout, rpc,
  releaseFetch = fetch } = {}) {
  run = requireSupervisedRun(undefined, run);
  const pair = { source_commit: release?.source_commit, carr_source_commit: release?.carr_source_commit };
  required(release?.service === 'doctorcre-app' && release?.environment === 'staging' &&
    SHA.test(pair.source_commit || '') && pair.carr_source_commit === contract.producer.source_commit &&
    plan?.schema === 'doctorcre-staging-records-plan.v1' && plan.state === 'complete' && !plan.inflight &&
    plan.origin === contract.origin && samePair(plan.release, pair) && UUID.test(plan.run || '') &&
    UUID.test(plan.records?.deal?.id || '') && plan.receipts?.deal?.deal_id === plan.records.deal.id &&
    plan.records.deal.name === `Synthetic staging QA ${plan.run} active deal`, 'agent-fixture-binding-refused');
  required(typeof run.root === 'string' && typeof run.snapshot === 'function' &&
    typeof run.http === 'function' && typeof run.reserveBytes === 'function' &&
    typeof run.snapshot().id === 'string', 'agent-run-binding-refused');
  const { readStagingManualW4Fixture } = await import('./records.mjs');
  const persisted = await readStagingManualW4Fixture(run.root, release, run);
  required(persisted.run === plan.run && samePair(persisted.release, plan.release) &&
    persisted.records.deal.id === plan.records.deal.id &&
    persisted.records.deal.name === plan.records.deal.name &&
    persisted.receipts.deal.deal_id === plan.receipts.deal.deal_id,
  'agent-fixture-binding-refused');
  plan = persisted;
  const journalPath = join(run.root, 'private', 'w4-local-agent-phase.json');
  const folder = await privateFolder(journalPath);
  await folder.close();
  const previous = await existingJournal(journalPath);
  required(!previous, 'agent-intent-already-exists'); // Never replay an uncertain write.
  const verifyRelease = async () => {
    for (const [url, kind] of [[contract.origin + '/app-release', 'app'],
      [contract.carr_origin + '/release', 'carr']]) {
      run.check();
      const response = await run.http(() => releaseFetch(url, { redirect: 'manual',
        signal: AbortSignal.any([run.signal, AbortSignal.timeout(run.limits.httpTimeoutMs)]) }));
      required(response.status === 200 && response.url === url, 'agent-live-source-refused');
      const actual = await response.json();
      required(kind === 'app' ? actual.service === 'doctorcre-app' &&
        actual.environment === 'staging' && actual.source_commit === pair.source_commit :
        actual.env?.value === 'staging' && actual.git_sha?.value === pair.carr_source_commit,
      'agent-live-source-refused');
    }
  };
  await verifyRelease();
  const call = rpc || await createLocalAgentRpc({ carrCheckout });
  const read = (name, args) => { run.check(); return run.http(() => call(name, args,
    { signal: run.signal, timeout: run.limits.httpTimeoutMs })); };
  const board = await read('deal-room-board', { workspace: 'all' });
  const matches = board.schema_version === 'local-deals-board.v1' && Array.isArray(board.deals)
    ? board.deals.filter(row => row.id === plan.records.deal.id) : [];
  required(board.actor === 'joe-local' && matches.length === 1 &&
    matches[0].name === plan.records.deal.name &&
    matches[0].phase === 'pending' && matches[0].owner === 'joe' &&
    matches[0].client_ref === plan.records.client?.ref &&
    (matches[0].field_base?.phase?.id === undefined || UUID.test(matches[0].field_base.phase.id)),
  'agent-fresh-base-refused');
  const before = await read('get-deal-room', { deal: plan.records.deal.id });
  required(before.deal_id === plan.records.deal.id && before.phase === 'pending' &&
    before.name === plan.records.deal.name && before.client_ref === plan.records.client.ref &&
    before.owner === 'joe' && before.phase_change?.event_id === matches[0].phase_change?.event_id,
  'agent-before-read-refused');
  const key = randomUUID();
  const args = { idempotency_key: key, deal: plan.records.deal.id,
    field: 'phase', value: 'research', base_event_id: matches[0].field_base?.phase?.id ?? null,
    change_reason: REASON };
  const journal = { schema: 'staging-w4-local-agent-phase.v1', state: 'inflight', source_pair: pair,
    run_id: run.snapshot().id, fixture_run: plan.run, deal_id: plan.records.deal.id,
    request: args, before_sha256: digest({ board: matches[0], detail: before }),
    started_at: new Date().toISOString(), doc_authorship_qualified: false };
  await secureJournal(journalPath, journal, run, true);
  try {
    const receipt = await read('patch-deal-field', args);
    required(receipt.ok === true && receipt.deal_id === args.deal && receipt.field === 'phase' &&
      receipt.old_value === 'pending' && receipt.new_value === 'research' &&
      UUID.test(receipt.event_id || '') && validDate(receipt.event_recorded_at), 'agent-receipt-refused');
    journal.state = 'received'; journal.receipt = receipt;
    await secureJournal(journalPath, journal, run);
    const afterBoard = await read('deal-room-board', { workspace: 'all' });
    const rows = afterBoard.schema_version === 'local-deals-board.v1' && Array.isArray(afterBoard.deals)
      ? afterBoard.deals.filter(row => row.id === args.deal) : [];
    const phase = rows[0]?.phase_change;
    required(afterBoard.actor === 'joe-local' && rows.length === 1 &&
      rows[0].phase === 'research' && phase?.automatic === true &&
      phase.event_id === receipt.event_id && phase.prior_phase === 'pending' &&
      phase.phase === 'research' && phase.reason === REASON && validDate(phase.evidence_date),
    'agent-board-readback-refused');
    const detail = await read('get-deal-room', { deal: args.deal });
    const events = Array.isArray(detail.events) ? detail.events.filter(row => row.id === receipt.event_id) : [];
    required(detail.deal_id === args.deal && detail.phase === 'research' &&
      detail.phase_change?.event_id === receipt.event_id && detail.phase_change.automatic === true &&
      events.length === 1 && events[0].actor === 'joe-local' && events[0].verb === 'patch-deal-field' &&
      events[0].field === 'phase' && events[0].old_value?.phase === 'pending' &&
      events[0].new_value?.phase === 'research', 'agent-detail-readback-refused');
    const activity = await read('read-doc-activity', { partner: 'joe', record_type: 'deal',
      since: receipt.event_recorded_at, limit: 100 });
    const entries = activity.schema_version === 'doc-activity.v1' && Array.isArray(activity.entries)
      ? activity.entries.filter(row => row.id === receipt.event_id) : [];
    required(entries.length === 1 && entries[0].actor === 'Joe (local)' &&
      entries[0].partner === 'joe' && entries[0].record?.id === args.deal &&
      entries[0].why === REASON && entries[0].before === 'pending' &&
      entries[0].after === 'research' && entries[0].undo?.event_id === receipt.event_id,
    'agent-cause-readback-refused');
    await verifyRelease();
    journal.state = 'observed';
    journal.board_sha256 = digest(afterBoard); journal.detail_sha256 = digest(detail);
    journal.cause_sha256 = digest(activity);
    journal.observed_at = new Date().toISOString();
    await secureJournal(journalPath, journal, run);
    return { schema: journal.schema, state: 'AUTOMATIC_SEAM_READY',
      event_sha256: digest(receipt.event_id), board_sha256: journal.board_sha256,
      detail_sha256: journal.detail_sha256, cause_sha256: journal.cause_sha256,
      doc_authorship_qualified: false,
      full_v1_qualified: false, journal_path: journalPath };
  } catch {
    // A timeout or rejected receipt may follow an accepted server write. Keep
    // its exact private intent, quarantine it, and never issue this key again.
    journal.state = 'quarantined'; journal.quarantined_at = new Date().toISOString();
    await secureJournal(journalPath, journal, run);
    return { schema: journal.schema, state: 'PENDING_RECONCILIATION',
      doc_authorship_qualified: false, full_v1_qualified: false, journal_path: journalPath };
  }
}
