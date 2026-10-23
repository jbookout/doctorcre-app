import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function verifyAppRelease(url, sourceCommit, environment, { fetchRelease = fetch, pause = setTimeout } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !['staging', 'production'].includes(environment)) {
    throw new Error('release verification requires a full source SHA and staging or production environment');
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetchRelease(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('release endpoint did not answer successfully');
      const release = await response.json();
      if (release?.service === 'doctorcre-app' && release.source_commit === sourceCommit && release.environment === environment) {
        return Object.fromEntries(['source_commit', 'environment', 'provider_version_id'].map(key => [key, release[key]]));
      }
    } catch {}
    if (attempt < 11) await pause(5000);
  }
  throw new Error(`release endpoint did not serve the expected ${environment} source ${sourceCommit} after 12 reads`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 5) throw new Error('usage: verify-app-release.mjs <release-url> <source-sha> <environment>');
    console.log(JSON.stringify(await verifyAppRelease(...process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
