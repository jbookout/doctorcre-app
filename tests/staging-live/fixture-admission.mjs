// Opt in only for synthetic adapters supplied by a test, with its own finite run.
export function admitFixtureRun(t) {
  const previous = { E2E_TARGET: process.env.E2E_TARGET, E2E_RUN_SUPERVISED: process.env.E2E_RUN_SUPERVISED };
  process.env.E2E_TARGET = 'staging-live';
  process.env.E2E_RUN_SUPERVISED = '1';
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}
