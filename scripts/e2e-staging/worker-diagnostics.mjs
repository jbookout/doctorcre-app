import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Names are a closed set of built-in error types, and a code is emitted only when
// one of this harness's own refusal helpers attached it; a code or name set by a
// library, provider or thrown value never reaches the diagnostic.
const SAFE_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'DOMException', 'RunLimitError', 'Object']);
const SAFE_CODE = /^[a-z0-9-]{1,64}$/;
const OWN_CODE = Symbol('staging-own-failure-code');
const SAFE_FRAME = /^scripts\/e2e-staging\/[A-Za-z0-9._/-]{1,180}\.mjs:[1-9][0-9]{0,8}$/;
const MAX_LINE_BYTES = 320;
const DIAGNOSTIC_LINE = /^Staging worker failure name=([A-Za-z][A-Za-z0-9]{0,63}) code=(none|[a-z0-9-]{1,64}) frame=(none|scripts\/e2e-staging\/[A-Za-z0-9._/-]{1,180}\.mjs:[1-9][0-9]{0,8})$/;

function firstStagingFrame(stack, projectRoot) {
  if (typeof stack !== 'string') return 'none';
  for (const line of stack.split('\n')) {
    const match = /^\s+at (?:.*? \()?((?:file:\/\/)?\/[^()\s]+):(\d+):\d+\)?$/.exec(line);
    if (!match) continue;
    let absolute = match[1];
    try { if (absolute.startsWith('file://')) absolute = fileURLToPath(absolute); }
    catch { continue; }
    const path = relative(projectRoot, absolute).split('\\').join('/');
    if (path === '..' || path.startsWith('../')) continue;
    const frame = `${path}:${match[2]}`;
    if (SAFE_FRAME.test(frame)) return frame;
  }
  return 'none';
}

export function markOwnFailureCode(error, code) {
  if (typeof code === 'string' && SAFE_CODE.test(code)) Object.defineProperty(error, OWN_CODE, { value: code });
  return error;
}

export function formatWorkerFailureDiagnostic(error, projectRoot) {
  let name = 'Error';
  try {
    const candidate = error?.constructor?.name;
    if (SAFE_NAMES.has(candidate)) name = candidate;
  } catch {}
  let code = 'none';
  try {
    const own = error && typeof error === 'object' ? error[OWN_CODE] : undefined;
    if (typeof own === 'string' && own === error.code) code = own;
  } catch {}
  let frame = 'none';
  try { frame = firstStagingFrame(error?.stack, projectRoot); } catch {}
  const line = `Staging worker failure name=${name} code=${code} frame=${frame}`;
  return Buffer.byteLength(line) <= MAX_LINE_BYTES
    ? line
    : 'Staging worker failure name=Error code=none frame=none';
}

export function parseWorkerFailureDiagnostic(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  const match = DIAGNOSTIC_LINE.exec(line);
  if (!match || !SAFE_NAMES.has(match[1]) || match[3] !== 'none' && !SAFE_FRAME.test(match[3])) return null;
  return line;
}
