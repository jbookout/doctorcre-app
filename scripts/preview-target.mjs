// The optional journey target can never select the production or staging app.
export function previewTarget(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  const hosted = url.protocol === 'https:' && !url.port &&
    /^(?:pr-[1-9]\d*|[a-f0-9]{8})-doctorcre-app-pr-[1-9]\d*\.joe-bookout-carr-us\.workers\.dev$/.test(url.hostname);
  if ((!local && !hosted) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('journeys require an isolated PR preview URL');
  return url.origin;
}
