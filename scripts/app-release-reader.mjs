export const APP_RELEASE_PATH = '/app-release';

// Callers own transport deadlines, byte/request caps and access refusals.
export async function readAppRelease(origin, read) {
  const response = await read(new URL(APP_RELEASE_PATH, origin));
  let release;
  try {
    if (!response.type.includes('json')) throw Error();
    release = JSON.parse(response.body.toString());
    if (release?.service !== 'doctorcre-app' || release.environment !== 'production'
      || typeof release.source_commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.source_commit)
      || /^0+$/.test(release.source_commit)) throw Error();
  } catch {
    throw Object.assign(new Error('Missing app release identity'), { exitCode: 78 });
  }
  return release;
}
