import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const EXPLORATION_MODEL_CALL_LIMIT = 20;

export function createModelCallBudget(limit = EXPLORATION_MODEL_CALL_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Model Room call limit must be a positive integer');
  let used = 0;
  return Object.freeze({
    reserve() {
      if (used >= limit) throw new Error(`Exploration aggregate model-call limit of ${limit} reached`);
      used += 1;
      return used;
    },
    snapshot() { return Object.freeze({ used, limit, remaining: limit - used }); },
  });
}

function parseDeskResult(row) {
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

export async function dispatchThroughModelRoom({ desk, task, fresh, signal }) {
  const dispatcher = process.env.CARR_MODEL_ROOM_DISPATCH?.trim();
  if (!dispatcher || !isAbsolute(dispatcher)) throw new Error('CARR_MODEL_ROOM_DISPATCH must name the absolute Model Room dispatcher path');
  if (fresh !== true) throw new Error('DoctorCRE E2E Model Room dispatches must use a fresh desk turn');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', [dispatcher, 'send', desk, '-', '--fresh'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length > 2_000_000) {
        child.kill('SIGTERM');
        finish(new Error('Model Room dispatcher output exceeded 2000000 characters'));
      }
      return next;
    };
    const abort = () => { child.kill('SIGTERM'); finish(new Error('Model Room dispatch aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(error));
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('close', code => {
      if (settled) return;
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
        return parseDeskResult(await dispatch({ desk, task: prepared.task, fresh: true, signal: options.abortSignal }));
      } finally { await prepared.cleanup(); }
    },
    async doStream() { throw new Error('DoctorCRE E2E Model Room adapter does not stream'); },
  });
}

// Config modules are re-evaluated for every exploration, while their imports
// remain shared in-process. One exported model therefore owns the aggregate cap.
export const explorationModelCallBudget = createModelCallBudget();
export const modelRoomExplorationModel = createModelRoomModel({ budget: explorationModelCallBudget });
