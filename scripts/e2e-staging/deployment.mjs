import { setTimeout as delay } from 'node:timers/promises';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

export function assertStagingDeployment(config) {
  const stage = config.env?.staging;
  if (stage?.name !== 'doctorcre-app-staging' || stage.workers_dev !== true || !Array.isArray(stage.routes) || stage.routes.length
    || stage.vars?.APP_ENV !== 'staging' || stage.services?.length !== 1
    || stage.services[0].binding !== 'CARR' || stage.services[0].service !== 'carr-mcp-staging') {
    throw new Error('E2E deployment requires the isolated staging Worker and CARR binding');
  }
}

export async function waitForStagingRelease(sourceCommit, {
  fetchRelease = () => fetch(`${contract.origin}/app-release`, { redirect: 'error', signal: AbortSignal.timeout(5_000) }),
  pause = delay,
} = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetchRelease();
      const release = response.ok ? await response.json() : null;
      if (release?.environment === 'staging' && release.source_commit === sourceCommit) return release;
    } catch { /* A read can reach an old edge while the published version propagates. */ }
    if (attempt < 5) await pause(2_500);
  }
  throw new Error('Staging candidate readback mismatch after bounded propagation checks');
}
