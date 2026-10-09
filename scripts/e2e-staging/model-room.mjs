import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const EXPLORATION_MODEL_CALL_POLICY = Object.freeze({ perGoal: 40, hardGlobalCeiling: 5_000 });
const EXPLORATION_CALLS_PER_GOAL = EXPLORATION_MODEL_CALL_POLICY.perGoal * 2 + 1;
const EXPLORATION_BATCH_GOAL_LIMIT = 50;
export const MODEL_ROOM_DISPATCH_CONTRACT = Object.freeze({
  revision: 'carr-model-room-dispatch@0b2c8ec8be07df142519e6638da9ec3329edcef2',
  repository: 'jbookout/carr-system',
  relativePath: 'tools/room-bridge/dispatch.py',
  sha256: '64e801f718242cf4bbd9a056a3b11e9d4faeea907c74ca0e18ca438fb2b2c61c',
  argv: Object.freeze(['send', '{desk}', '-', '--fresh']),
});
const DISPATCH_TERMINATION_GRACE_MS = 250;
const dispatcherEnvelopeKeys = new Set([
  'msg_id', 'desk', 'kind', 'task', 'dispatched_at', 'status', 'result', 'thread_id', 'resumed',
  'actual_model', 'finish', 'provider', 'retrieval', 'code', 'detail', 'error', 'retry_after',
]);

export function createExplorationCallPlan(goalCount) {
  if (!Number.isSafeInteger(goalCount) || goalCount < 0) throw new Error('Exploration goal count must be a non-negative integer');
  const { perGoal, hardGlobalCeiling } = EXPLORATION_MODEL_CALL_POLICY;
  const callsPerGoal = EXPLORATION_CALLS_PER_GOAL;
  const scheduled = callsPerGoal * goalCount;
  if (!Number.isSafeInteger(scheduled) || scheduled > hardGlobalCeiling) {
    throw new Error(`Exploration schedule requires ${scheduled} model calls, above the hard global ceiling of ${hardGlobalCeiling}`);
  }
  return Object.freeze({ goalCount, perGoal, callsPerGoal, scheduled, limit: scheduled, hardGlobalCeiling });
}

export function formatExplorationCallPlan(plan) {
  return `Model Room budget: ${plan.callsPerGoal} planned calls per goal × ${plan.goalCount} goals = ${plan.scheduled}; finite run cap ${plan.limit}; hard global ceiling ${plan.hardGlobalCeiling}; exploration step limit ${plan.perGoal}`;
}

export function createExplorationBatchPlan(goalCount) {
  if (!Number.isSafeInteger(goalCount) || goalCount < 0) throw new Error('Exploration goal count must be a non-negative integer');
  const batches = [];
  for (let start = 0; start < goalCount; start += EXPLORATION_BATCH_GOAL_LIMIT) {
    const goals = Math.min(EXPLORATION_BATCH_GOAL_LIMIT, goalCount - start);
    const plan = createExplorationCallPlan(goals);
    batches.push(Object.freeze({ number: batches.length + 1, start, goalCount: goals, plannedCalls: plan.scheduled }));
  }
  const totalCalls = EXPLORATION_CALLS_PER_GOAL * goalCount;
  if (!Number.isSafeInteger(totalCalls)) throw new Error('Exploration batch total exceeds the safe integer range');
  return Object.freeze({ goalCount, callsPerGoal: EXPLORATION_CALLS_PER_GOAL, totalCalls, batches: Object.freeze(batches) });
}

export function formatExplorationBatchPlan(plan) {
  const batches = plan.batches.map(batch => `batch ${batch.number}: ${batch.goalCount} goals / ${batch.plannedCalls} calls`).join('; ') || 'no pending batches';
  return `Model Room sweep plan: ${plan.goalCount} pending goals × ${plan.callsPerGoal} planned calls = ${plan.totalCalls} total; ${batches}`;
}

function modelCallBudget(limit, allowZero = false) {
  if (!Number.isSafeInteger(limit) || limit < (allowZero ? 0 : 1)) throw new Error('Model Room call limit must be a positive integer');
  let maximum = limit;
  let used = 0;
  const budget = Object.freeze({
    reserve() {
      if (used >= maximum) throw new Error(`Exploration aggregate model-call limit of ${maximum} reached; resume from the saved sweep checkpoint`);
      used += 1;
      return used;
    },
    snapshot() { return Object.freeze({ used, limit: maximum, remaining: maximum - used }); },
  });
  return {
    budget,
    setLimit(next) {
      if (used !== 0) throw new Error('Model Room call budget cannot be reconfigured after use');
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('Model Room call limit must be a non-negative integer');
      maximum = next;
    },
  };
}

export function createModelCallBudget(limit = EXPLORATION_MODEL_CALL_POLICY.hardGlobalCeiling) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Model Room call limit must be a positive integer');
  return modelCallBudget(limit).budget;
}

function requireDispatcherEnvelope(row, expected) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`unknown Model Room dispatcher envelope for ${MODEL_ROOM_DISPATCH_CONTRACT.revision}`);
  const unknown = Object.keys(row).filter(key => !dispatcherEnvelopeKeys.has(key));
  const optionalTypes = [
    ['thread_id', value => typeof value === 'string'],
    ['resumed', value => typeof value === 'boolean'],
    ['actual_model', value => typeof value === 'string'],
    ['finish', value => typeof value === 'string'],
    ['provider', value => typeof value === 'string'],
    ['retrieval', value => value && typeof value === 'object' && !Array.isArray(value)],
    ['code', value => Number.isSafeInteger(value)],
    ['detail', value => typeof value === 'string'],
    ['error', value => typeof value === 'string'],
    ['retry_after', value => value === null || typeof value === 'string'],
  ];
  const valid = unknown.length === 0
    && typeof row.msg_id === 'string'
    && row.desk === expected.desk
    && typeof row.kind === 'string'
    && row.task === expected.task
    && typeof row.dispatched_at === 'string'
    && typeof row.status === 'string'
    && optionalTypes.every(([key, accepts]) => !(key in row) || accepts(row[key]));
  if (!valid) throw new Error(`unknown Model Room dispatcher envelope for ${MODEL_ROOM_DISPATCH_CONTRACT.revision}`);
  return row;
}

function parseDeskResult(row, expected) {
  requireDispatcherEnvelope(row, expected);
  if (row?.status !== 'completed' || typeof row.result !== 'string') {
    throw new Error(`Model Room desk did not complete: ${row?.detail || row?.status || 'invalid response'}`);
  }
  const trimmed = row.result.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  let result;
  try { result = JSON.parse((fenced?.[1] ?? trimmed).trim()); }
  catch (cause) { throw new Error('Model Room desk returned invalid JSON', { cause }); }
  if (!Array.isArray(result.content) || result.content.length === 0) throw new Error('Model Room desk returned no content');
  const content = result.content.map((part, index) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'tool-call' && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
      const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input);
      if (typeof input !== 'string') throw new Error(`Model Room tool call ${index} has no JSON input`);
      return { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input };
    }
    throw new Error(`Model Room content ${index} has an unsupported shape`);
  });
  const toolCalls = content.some(part => part.type === 'tool-call');
  return {
    content,
    finishReason: { unified: toolCalls ? 'tool-calls' : 'stop', raw: 'model-room' },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}

function extension(mediaType) {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  return 'bin';
}

async function portable(value, directory, counter) {
  if (value instanceof Uint8Array) {
    const path = join(directory, `input-${String(++counter.value).padStart(3, '0')}.bin`);
    await writeFile(path, value, { mode: 0o600 });
    return { localPath: path };
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => portable(item, directory, counter)));
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof URL) return value.href;
  if (value.type === 'file' && (typeof value.data === 'string' || value.data instanceof Uint8Array)) {
    const path = join(directory, `input-${String(++counter.value).padStart(3, '0')}.${extension(value.mediaType)}`);
    const data = typeof value.data === 'string' ? Buffer.from(value.data, 'base64') : value.data;
    await writeFile(path, data, { mode: 0o600 });
    return { ...value, data: { localPath: path } };
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = await portable(child, directory, counter);
  return result;
}

async function modelRoomTask(options) {
  const directory = await mkdtemp(join(tmpdir(), 'doctorcre-e2e-model-room-'));
  const request = await portable({
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    stopSequences: options.stopSequences,
    responseFormat: options.responseFormat,
    tools: options.tools,
    toolChoice: options.toolChoice,
  }, directory, { value: 0 });
  const task = `Act as the language-model transport for one DoctorCRE E2E step. Inspect any localPath evidence before answering. Return exactly one JSON object, without Markdown fences, with a nonempty content array. Each content item must be either {"type":"text","text":"..."} or {"type":"tool-call","toolCallId":"unique-id","toolName":"one supplied tool","input":{...}}. Use tool calls when the request supplies tools and an action is needed. The complete AI SDK request follows:\n${JSON.stringify(request)}`;
  return { task, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function signalProcessGroup(child, name) {
  try {
    if (process.platform === 'win32') child.kill(name);
    else process.kill(-child.pid, name);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function assertDispatcherContract(dispatcher, contract) {
  let digest;
  try { digest = createHash('sha256').update(await readFile(dispatcher)).digest('hex'); }
  catch { throw new Error(`CARR_MODEL_ROOM_DISPATCH does not match the pinned Model Room dispatcher ${contract.revision}`); }
  if (digest !== contract.sha256) throw new Error(`CARR_MODEL_ROOM_DISPATCH does not match the pinned Model Room dispatcher ${contract.revision}`);
}

export async function dispatchThroughModelRoom({ desk, task, fresh, signal, dispatcherPath, environment, dispatcherContract = MODEL_ROOM_DISPATCH_CONTRACT }) {
  const dispatcher = (dispatcherPath || process.env.CARR_MODEL_ROOM_DISPATCH)?.trim();
  if (!dispatcher || !isAbsolute(dispatcher)) throw new Error('CARR_MODEL_ROOM_DISPATCH must name the absolute Model Room dispatcher path');
  if (fresh !== true) throw new Error('DoctorCRE E2E Model Room dispatches must use a fresh desk turn');
  await assertDispatcherContract(dispatcher, dispatcherContract);
  return new Promise((resolve, reject) => {
    const args = dispatcherContract.argv.map(value => value === '{desk}' ? desk : value);
    const child = spawn(process.env.PYTHON || 'python3', [dispatcher, ...args], {
      detached: process.platform !== 'win32',
      env: environment || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false, terminating = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    let closeResolve;
    const closed = new Promise(resolveClose => { closeResolve = resolveClose; });
    const terminate = async error => {
      if (terminating || settled) return;
      terminating = true;
      signalProcessGroup(child, 'SIGTERM');
      const exited = await Promise.race([closed.then(() => true), delay(DISPATCH_TERMINATION_GRACE_MS, false)]);
      if (!exited) signalProcessGroup(child, 'SIGKILL');
      await closed;
      finish(error);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length > 2_000_000) {
        void terminate(new Error('Model Room dispatcher output exceeded 2000000 characters'));
      }
      return next;
    };
    const abort = () => { void terminate(new Error('Model Room dispatch aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(error));
    child.stdin.once('error', error => { if (!terminating) finish(error); });
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('close', code => {
      closeResolve();
      if (settled || terminating) return;
      if (code !== 0) return finish(new Error(`Model Room dispatcher failed (${code}): ${stderr.trim().slice(-500)}`));
      try { finish(null, JSON.parse(stdout)); }
      catch (cause) { finish(new Error('Model Room dispatcher returned invalid JSON', { cause })); }
    });
    child.stdin.end(task);
    if (signal?.aborted) abort();
  });
}

export function createModelRoomModel({
  desk = process.env.E2E_MODEL_ROOM_DESK?.trim() || 'doctorcre-e2e',
  budget = createModelCallBudget(),
  dispatch = dispatchThroughModelRoom,
} = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(desk)) throw new Error('E2E_MODEL_ROOM_DESK must be a named Model Room desk');
  return Object.freeze({
    specificationVersion: 'v3',
    provider: 'carr-model-room',
    modelId: desk,
    supportedUrls: {},
    async doGenerate(options) {
      const prepared = await modelRoomTask(options);
      try {
        budget.reserve();
        const row = await dispatch({ desk, task: prepared.task, fresh: true, signal: options.abortSignal });
        return parseDeskResult(row, { desk, task: prepared.task });
      } finally { await prepared.cleanup(); }
    },
    async doStream() { throw new Error('DoctorCRE E2E Model Room adapter does not stream'); },
  });
}

// Config modules are re-evaluated for every exploration, while their imports
// remain shared in-process. One exported model therefore owns the aggregate cap.
const sharedExplorationBudget = modelCallBudget(EXPLORATION_MODEL_CALL_POLICY.hardGlobalCeiling, true);
export const explorationModelCallBudget = sharedExplorationBudget.budget;
export function configureExplorationModelCallBudget(goalCount) {
  const plan = createExplorationCallPlan(goalCount);
  sharedExplorationBudget.setLimit(plan.limit);
  return plan;
}
export const modelRoomExplorationModel = createModelRoomModel({ budget: explorationModelCallBudget });
