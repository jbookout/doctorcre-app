import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SAFE_CODE = /^[a-z0-9-]{1,64}$/;
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

export function formatWorkerFailureDiagnostic(error, projectRoot) {
  let name = 'Error';
  try {
    const candidate = error?.constructor?.name;
    if (typeof candidate === 'string' && SAFE_NAME.test(candidate)) name = candidate;
  } catch {}
  let code = 'none';
  try {
    if (error && typeof error === 'object' && Object.hasOwn(error, 'code') &&
        typeof error.code === 'string' && SAFE_CODE.test(error.code)) code = error.code;
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
  if (!match || match[3] !== 'none' && !SAFE_FRAME.test(match[3])) return null;
  return line;
}
