// Home's data client, started before the dashboard's module graph finishes
// loading. workspace.html loads this as an async module, so the client
// download overlaps the shell instead of queuing behind it, and each mode
// fetches only its own client: live never downloads the fixture client.
import { resolveDealroomBoot } from './boot-mode.js';

async function createHomeClient(boot) {
  if (boot.mode === 'live') {
    const [{ createLiveClient }, { createLeadBoardClient }, { createLeaseRadarClient }] = await Promise.all([
      import('./live-client.js'), import('./leads-client.js'), import('./lease-radar-client.js')]);
    const client = createLiveClient({ docContext: false });
    client.getLeadBoard = createLeadBoardClient({ docContext: false }).getLeadBoard;
    client.readLeaseRadar = createLeaseRadarClient().readLeaseRadar;
    return client;
  }
  const [{ createFixtureClient }, { leaseRadarFixture }] = await Promise.all([
    import('./fixture-client.js'), import('./lease-radar-fixture.js')]);
  const client = await createFixtureClient({ ...boot.options, docContext: false });
  client.getLeadBoard = async () => ({ leads: [] });
  client.readLeaseRadar = async () => leaseRadarFixture();
  return client;
}

export const homeClient = typeof location === 'undefined' ? null : createHomeClient(resolveDealroomBoot(location));
