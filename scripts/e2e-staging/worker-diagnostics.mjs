import { readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Names are a closed set of built-in error types, a code is emitted only when one
// of this harness's own refusal helpers registered it, and a frame is only the
// name of a source file that ships in scripts/e2e-staging, without a line number
// a forged stack could fill; nothing a library, provider or thrown value
// controls reaches the diagnostic.
const SAFE_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'DOMException', 'RunLimitError', 'Object']);
const SAFE_CODE = /^[a-z0-9-]{1,64}$/;
const ownCodes = new WeakMap();
const STAGING_SOURCES = new Set(readdirSync(new URL('./', import.meta.url), { recursive: true })
  .map(path => String(path).split('\\').join('/'))
  .filter(path => path.endsWith('.mjs'))
  .map(path => `scripts/e2e-staging/${path}`));
const MAX_LINE_BYTES = 320;
const DIAGNOSTIC_LINE = /^Staging worker failure name=([A-Za-z][A-Za-z0-9]{0,63}) code=(none|[a-z0-9-]{1,64}) frame=(none|scripts\/e2e-staging\/[A-Za-z0-9._/-]{1,180}\.mjs)$/;

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
    if (STAGING_SOURCES.has(path)) return path;
  }
  return 'none';
}

export function markOwnFailureCode(error, code) {
  if (typeof code === 'string' && SAFE_CODE.test(code)) ownCodes.set(error, code);
  return error;
}

export function formatWorkerFailureDiagnostic(error, projectRoot) {
  let name = 'Error';
  try {
    const candidate = error?.constructor?.name;
    if (SAFE_NAMES.has(candidate)) name = candidate;
  } catch {}
  // WeakMap lookup is by identity, so a Proxy's traps never run here.
  const code = (error && typeof error === 'object' && ownCodes.get(error)) || 'none';
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
  if (!match || !SAFE_NAMES.has(match[1])) return null;
  if (match[3] !== 'none' && !STAGING_SOURCES.has(match[3])) return null;
  return line;
}
