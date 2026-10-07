import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { newDeadControls, sweepFindings } from './report.mjs';
import { canContinueTraversal, validateTraversal } from './traversal.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const statuses = new Set(['OBSERVED', 'DEAD', 'DISABLED', 'ERROR', 'UNREACHABLE']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const pair = (target, path) => JSON.stringify([target, path]);
const requireCheckpoint = value => { if (!value) throw new Error('Staging sweep checkpoint is invalid; no screen was retried'); };
const sourceRelease = release => release?.service === 'doctorcre-app' && release.environment === 'staging' && /^[0-9a-f]{40}$/.test(release.source_commit || '') && release.carr_source_commit === contract.producer.source_commit;
const complete = screen => screen?.reached === true && screen.in_progress !== true && !screen.failure && !screen.exhausted && screen.controls.length > 0 && screen.controls.every(row => !['ERROR', 'UNREACHABLE'].includes(row.status) && (row.status !== 'DISABLED' || typeof row.reason === 'string' && row.reason.trim() && row.reason !== 'No reason provided'));

export async function readSweepCheckpoint(output) {
  try { return JSON.parse(await readFile(join(output, 'controls.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Staging sweep checkpoint could not be read; no screen was retried');
  }
}

export function createSweepRun({ targets, routedScreens, prior }) {
  const planned = targets.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface).map(screen => ({ target, screen })));
  const plan = new Map(planned.map(entry => [pair(entry.target.name, entry.screen.path), entry]));
  requireCheckpoint(planned.length > 0 && plan.size === planned.length);
  const validateScreen = screen => {
    requireCheckpoint(screen && typeof screen === 'object' && !Array.isArray(screen));
    const expected = plan.get(pair(screen.target, screen.path));
    requireCheckpoint(expected && screen.name === expected.screen.name && screen.surface === expected.screen.surface && typeof screen.reached === 'boolean' && (screen.exhausted === undefined || typeof screen.exhausted === 'boolean') && Array.isArray(screen.controls));
    requireCheckpoint(screen.in_progress === undefined || typeof screen.in_progress === 'boolean');
    requireCheckpoint(screen.attempt_id === undefined || typeof screen.attempt_id === 'string' && uuid.test(screen.attempt_id));
    if (screen.failure != null) requireCheckpoint(typeof screen.failure.phase === 'string' && /^[a-z][a-z0-9-]*$/.test(screen.failure.phase) && typeof screen.failure.code === 'string' && /^[a-z][a-z0-9-]*$/.test(screen.failure.code) && strings(screen.failure.openers || []));
    if (screen.prior_failures !== undefined) {
      requireCheckpoint(Array.isArray(screen.prior_failures));
      for (const failure of screen.prior_failures) requireCheckpoint(failure && /^[a-z][a-z0-9-]*$/.test(failure.phase) && /^[a-z][a-z0-9-]*$/.test(failure.code) && strings(failure.openers || []) && Number.isSafeInteger(failure.retained_controls) && failure.retained_controls >= 0 && failure.retained_controls <= screen.controls.length);
    }
    const keys = new Set();
    for (const row of screen.controls) {
      requireCheckpoint(row && typeof row === 'object' && row.target === screen.target && row.path === screen.path && row.screen === screen.name && typeof row.key === 'string' && row.key.startsWith(`${screen.target}/${screen.path}/`) && /^[0-9a-f]{16}$/.test(row.key.slice(`${screen.target}/${screen.path}/`.length)) && !keys.has(row.key));
      requireCheckpoint(statuses.has(row.status) && typeof row.selector === 'string' && row.selector.length > 0 && strings(row.openers) && strings(row.signals) && (row.evidence_path === undefined || typeof row.evidence_path === 'string') && (row.reason === undefined || typeof row.reason === 'string'));
      keys.add(row.key);
    }
    if (screen.traversal) validateTraversal(screen);
  };
  const measured = new Map(), history = [];
  if (prior !== undefined) {
    requireCheckpoint(prior && typeof prior === 'object' && sourceRelease(prior.release) && Array.isArray(prior.screens) && (prior.history === undefined || Array.isArray(prior.history)));
    for (const screen of prior.screens) {
      validateScreen(screen);
      const key = pair(screen.target, screen.path);
      requireCheckpoint(!measured.has(key));
      measured.set(key, structuredClone(screen));
    }
    const attempts = new Set();
    for (const entry of prior.history || []) {
      requireCheckpoint(entry && typeof entry === 'object' && Array.isArray(entry.findings));
      validateScreen(entry.screen);
      const key = `${entry.screen.attempt_id || 'legacy'}|${pair(entry.screen.target, entry.screen.path)}`;
      requireCheckpoint(!complete(entry.screen) && !attempts.has(key) && JSON.stringify(entry.findings) === JSON.stringify(sweepFindings([entry.screen])));
      const current = measured.get(pair(entry.screen.target, entry.screen.path));
      requireCheckpoint(!current || (current.attempt_id || 'legacy') !== (entry.screen.attempt_id || 'legacy'));
      attempts.add(key);
      history.push(structuredClone(entry));
    }
  }
  const pending = planned.filter(({ target, screen }) => !complete(measured.get(pair(target.name, screen.path))));
  const continuationIDs = new Map([...measured].filter(([, screen]) => canContinueTraversal(screen)).map(([key, screen]) => [key, screen.attempt_id]));
  const attemptID = randomUUID();
  let number = 0;
  return {
    pending,
    priorScreen(target, path) { return structuredClone(measured.get(pair(target, path))); },
    assertRelease(release) {
      if (!sourceRelease(release) || prior && (prior.release.source_commit !== release.source_commit || prior.release.carr_source_commit !== release.carr_source_commit)) throw new Error('Staging sweep requires the same pinned source pair; no screen was retried');
    },
    record(screen) {
      validateScreen(screen);
      const key = pair(screen.target, screen.path), old = measured.get(key);
      if (complete(old)) throw new Error('A complete screen cannot be replaced by resume');
      const currentAttempt = continuationIDs.get(key) || attemptID;
      if (old?.attempt_id === currentAttempt && (screen.controls.length < old.controls.length || JSON.stringify(screen.controls.slice(0, old.controls.length)) !== JSON.stringify(old.controls))) throw new Error('Measured control evidence cannot be replaced during frontier continuation');
      if (old && old.attempt_id !== currentAttempt) history.push({ screen: structuredClone(old), findings: sweepFindings([old]) });
      measured.set(key, { ...structuredClone(screen), attempt_id: currentAttempt });
    },
    snapshot() { return structuredClone({ screens: planned.map(({ target, screen }) => measured.get(pair(target.name, screen.path))).filter(Boolean), history, expectedScreens: planned.length, expectedExplorations: planned.reduce((count, { target }) => count + (target.name.endsWith('phone') ? 1 : 2), 0) }); },
    verdict(allowlist) {
      const controls = [...measured.values(), ...history.map(entry => entry.screen)].flatMap(screen => screen.controls);
      const dead = newDeadControls(controls, allowlist);
      return { completed: measured.size === planned.length && planned.every(({ target, screen }) => complete(measured.get(pair(target.name, screen.path)))), newDeadControls: [...new Set(dead.map(row => row.key))] };
    },
    evidencePaths(output, privateRoot, status) {
      requireCheckpoint(statuses.has(status));
      const filename = `${String(++number).padStart(5, '0')}-${status}`;
      const privateDir = join(privateRoot, attemptID, filename), publicDir = join(output, 'evidence', 'sweep', attemptID);
      return { privateDir, publicDir, png: join(privateDir, `${filename}.png`), trace: join(privateDir, `${filename}.zip`), publishedPNG: join(publicDir, `${filename}.png`) };
    },
  };
}

export function sweepOptions(args) {
  if (args.length === 0) return { resume: false };
  if (args.length === 1 && args[0] === '--resume') return { resume: true };
  throw new Error('Staging sweep accepts only --resume or no arguments');
}
