import { sweepScreen } from './controls.mjs';
import { readCalendarContext, runCalendarCase } from './calendar-coverage.mjs';
import { recordCalendarState } from './state-plan.mjs';

// Owners execute each pending obligation once per invocation. Failed owners
// remain pending for explicit resume; newly registered destinations are included.
// `admit` runs before each obligation; a budgeted caller charges it there and
// a refusal ends the walk.
export async function sweepOwnerStates({ run, targets, routedScreens, freshPageFor, evidence, persist, sweep = sweepScreen, admit = async () => {} }) {
  const visited = new Set(), inspected = new Set();
  while (true) {
    const entry = run.pendingStates().find(row => !visited.has(row.key));
    if (!entry) break;
    visited.add(entry.key);
    await admit(entry);
    const target = targets.find(row => row.name === entry.target);
    const screen = routedScreens.find(row => row.path === entry.spec.owner && row.surface === target.surface);
    const freshPage = freshPageFor(target, screen, entry.spec);
    if (entry.spec.owner === '/calendar' && !inspected.has(target.name)) {
      let page, records, evidence_path;
      try {
        page = await freshPageFor(target, screen, { kind: 'workspace', url: '/calendar' })();
        records = (await readCalendarContext(page)).entries;
        evidence_path = await evidence(page, { status: 'OBSERVED' });
      } catch {
        const failure = { phase: 'calendar-coverage', code: 'calendar-inventory-failed', openers: [] };
        run.recordState(entry.key, entry.spec.kind === 'calendar-operation'
          ? { spec: entry.spec, status: 'failed', steps: [], failure }
          : { ...(entry.result || { ...screen, target: target.name, state_scope: entry.key, reached: false, controls: [] }), failure });
        await persist();
        continue;
      } finally { if (page) await page.context().close(); }
      for (const record of records) {
        const spec = recordCalendarState(record);
        run.requireState(target.name, spec, { kind: 'calendar-read', target: target.name, path: '/calendar', entry_binding: spec.entry_binding, evidence_path });
      }
      await persist();
      inspected.add(target.name);
    }
    if (entry.spec.kind === 'calendar-operation') {
      run.recordState(entry.key, await runCalendarCase({ spec: entry.spec, freshPage, evidence }));
      await persist();
    } else {
      let result;
      try {
        result = await sweep({ freshPage, screen, target: target.name, identityScope: entry.key, prior: entry.result,
          routedPaths: routedScreens.map(row => row.path), evidence, checkpoint: async partial => {
            run.recordState(entry.key, partial);
            await persist();
          } });
      } catch {
        result = { ...(run.pendingStates().find(row => row.key === entry.key)?.result || { ...screen, target: target.name, reached: false, controls: [], state_scope: entry.key }),
          failure: { phase: 'owner-state', code: 'unexpected-owner-sweep-failure', openers: [] } };
      }
      run.recordState(entry.key, result);
      await persist();
    }
  }
  return run.snapshot().stateObligations;
}
